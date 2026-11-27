/**
 * Database access for meeting reports. #291.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD 01).
 */

import { type Kysely, sql } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import { type NewOutboxEmail, validateOutboxEmail } from '../../core/notification/outbox.js';
import { EmailOutboxRepository } from '../../core/notification/outbox.db.js';
import type { MeetingReportScope } from './policy.js';
import type { MeetingReport, Period, ReportFigures, ReportSection } from './meeting-report.js';

/** A report with its saved figures, and when they were saved. */
export type SavedReport = MeetingReport &
  ReportFigures & { sections: ReportSection[]; figuresAt: Date };

/** The index that holds an author to one draft at a time. */
const ONE_DRAFT = 'uq_clients_meeting_report_one_draft';

/** Thrown by {@link ClientsMeetingReportRepository.add} where the author has a draft already. */
export class DraftAlreadyThere extends Error {
  constructor() {
    super('This author has a draft already.');
    this.name = 'DraftAlreadyThere';
  }
}

export class ClientsMeetingReportRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * The reports somebody may list, scoped here in the query rather than filtered after (NFR CLI
   * SEC 05): their own, those they discarded left out, and for a BD manager everybody's shared
   * ones. Newest first.
   */
  async listFor(scope: MeetingReportScope): Promise<MeetingReport[]> {
    const rows = await reports(this.db)
      .where((eb) =>
        eb.or([
          eb.and([eb('r.author_id', '=', scope.authorId), eb('r.status', '<>', 'DISCARDED')]),
          ...(scope.everyShared ? [eb('r.status', '=', 'SHARED')] : []),
        ]),
      )
      .orderBy(sql`coalesce(r.shared_at, r.created_at)`, 'desc')
      .orderBy('r.id', 'desc')
      .execute();

    return rows.map(reportFrom);
  }

  /**
   * One report, with its saved figures, where the scope lets them read it: their own, whatever
   * its state, and for a BD manager a shared one. Scoped here in the query, so a report nobody
   * may read is never fetched for them at all (NFR CLI SEC 05).
   */
  async findFor(id: string, scope: MeetingReportScope): Promise<SavedReport | undefined> {
    const row = await reports(this.db)
      .select(['r.figures', 'r.figures_at', 'r.sections'])
      .where('r.id', '=', id)
      .where((eb) =>
        eb.or([
          eb('r.author_id', '=', scope.authorId),
          ...(scope.everyShared ? [eb('r.status', '=', 'SHARED')] : []),
        ]),
      )
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          ...reportFrom(row),
          ...(row.figures as ReportFigures),
          sections: row.sections as ReportSection[],
          figuresAt: row.figures_at,
        };
  }

  /**
   * Whose a report is and its state, and nothing of what it says: for writing down a refused look
   * at one that is not theirs. Undefined where there is no such report.
   */
  async subjectOf(
    id: string,
  ): Promise<{ id: string; author: { id: string }; status: MeetingReport['status'] } | undefined> {
    const row = await this.db
      .selectFrom('clients_meeting_report')
      .select(['id', 'author_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : { id: row.id, author: { id: row.author_id }, status: row.status };
  }

  /** The last day of the report somebody shared most recently, or null if they never have. */
  async lastSharedTo(authorId: string): Promise<CalendarDate | null> {
    const row = await this.db
      .selectFrom('clients_meeting_report')
      .select('period_to')
      .where('author_id', '=', authorId)
      .where('status', '=', 'SHARED')
      .orderBy('shared_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row?.period_to ?? null;
  }

  /** Somebody's draft, or undefined while they have none. */
  async draftOf(authorId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('clients_meeting_report')
      .select('id')
      .where('author_id', '=', authorId)
      .where('status', '=', 'DRAFT')
      .executeTakeFirst();

    return row?.id;
  }

  /**
   * A new draft, with its figures as they stand now. Throws {@link DraftAlreadyThere} where the
   * author has one.
   */
  async add(
    by: Attribution,
    authorId: string,
    period: Period,
    figures: ReportFigures,
    sections: readonly ReportSection[],
  ): Promise<string> {
    try {
      return await recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_meeting_report')
          .values({
            author_id: authorId,
            period_from: period.from,
            period_to: period.to,
            figures: JSON.stringify(figures),
            sections: JSON.stringify(sections),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return row.id;
      });
    } catch (error) {
      if ((error as { constraint?: unknown }).constraint === ONE_DRAFT) {
        throw new DraftAlreadyThere();
      }
      throw error;
    }
  }

  /**
   * Saves a draft's figures afresh, as of now. False where it is no longer a draft, whose figures
   * stay as they were shared.
   */
  async saveFigures(by: Attribution, id: string, figures: ReportFigures): Promise<boolean> {
    const rows = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_meeting_report')
        .set({ figures: JSON.stringify(figures), figures_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .execute(),
    );

    return rows.length > 0;
  }

  /**
   * A draft's new period, with its figures for it, as of now. False where it is no longer a draft.
   */
  async changePeriod(
    by: Attribution,
    id: string,
    period: Period,
    figures: ReportFigures,
  ): Promise<boolean> {
    const rows = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_meeting_report')
        .set({
          period_from: period.from,
          period_to: period.to,
          figures: JSON.stringify(figures),
          figures_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .execute(),
    );

    return rows.length > 0;
  }

  /**
   * Shares a draft: its figures saved a last time, as of now, and it fixed for good; with the
   * emails telling whoever may now read it, queued in the same transaction, so it is shared and
   * told or neither. False where it is no longer a draft, and nothing is queued.
   */
  async share(
    by: Attribution,
    id: string,
    figures: ReportFigures,
    emails: readonly NewOutboxEmail[],
  ): Promise<boolean> {
    return recording(this.db, by, async (on) => {
      const rows = await on
        .updateTable('clients_meeting_report')
        .set({
          status: 'SHARED',
          shared_at: sql<Date>`now()`,
          figures: JSON.stringify(figures),
          figures_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .execute();

      if (rows.length === 0) {
        return false;
      }

      const outbox = new EmailOutboxRepository(on);
      for (const email of emails) {
        await outbox.queue(validateOutboxEmail(email));
      }

      return true;
    });
  }

  /** A draft's written sections, as given. False where it is no longer a draft. */
  async writeSections(
    by: Attribution,
    id: string,
    sections: readonly ReportSection[],
  ): Promise<boolean> {
    const rows = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_meeting_report')
        .set({ sections: JSON.stringify(sections) })
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .execute(),
    );

    return rows.length > 0;
  }

  /** Throws a draft away, keeping it. False where it is no longer a draft. */
  async discard(by: Attribution, id: string): Promise<boolean> {
    const rows = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_meeting_report')
        .set({ status: 'DISCARDED', discarded_at: sql<Date>`now()` })
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .execute(),
    );

    return rows.length > 0;
  }
}

/** Every report, with its author's name. */
function reports(db: Kysely<Database>) {
  return db
    .selectFrom('clients_meeting_report as r')
    .innerJoin('employee as e', 'e.id', 'r.author_id')
    .select([
      'r.id',
      'r.status',
      'r.created_at',
      'r.shared_at',
      'r.discarded_at',
      'e.id as author_id',
      sql<string>`e.first_name || ' ' || e.last_name`.as('author_name'),
      'r.period_from',
      'r.period_to',
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof reports>['executeTakeFirstOrThrow']>>;

function reportFrom(row: Row): MeetingReport {
  return {
    id: row.id,
    author: { id: row.author_id, name: row.author_name },
    period: { from: row.period_from, to: row.period_to },
    status: row.status,
    createdAt: row.created_at,
    sharedAt: row.shared_at,
    discardedAt: row.discarded_at,
  };
}
