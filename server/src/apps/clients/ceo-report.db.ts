/**
 * Database access for CEO reports, and the meeting reports they are built from. #292.
 *
 * Every write goes through `recording()`, so the audit trigger knows who made it (NFR CLI AUD 01).
 * What anybody may see is scoped here, in the query (NFR CLI SEC 05): a BD manager their own, the
 * Chief Executive every submitted one.
 */

import { type Kysely, sql, type UpdateObject } from 'kysely';
import type { Attribution } from '../../core/audit/audit.js';
import type { CalendarDate } from '../../core/calendar/time.js';
import type { Database } from '../../core/db/index.js';
import { recording } from '../../core/db/recording.js';
import { type NewOutboxEmail, validateOutboxEmail } from '../../core/notification/outbox.js';
import { EmailOutboxRepository } from '../../core/notification/outbox.db.js';
import type { CeoReport, CeoReportFigures, CeoReportStatus, SharedReport } from './ceo-report.js';
import type { Period, ReportFigures, ReportSection } from './meeting-report.js';
import type { CeoReportScope } from './policy.js';

/** The index that holds an author to one draft at a time. */
const ONE_DRAFT = 'uq_clients_ceo_report_one_draft';

/** A report with its saved figures and sections, and when the figures were saved. */
export type SavedCeoReport = CeoReport &
  CeoReportFigures & { sections: ReportSection[]; figuresAt: Date };

/** Thrown by {@link ClientsCeoReportRepository.add} where the author has a draft already. */
export class CeoDraftAlreadyThere extends Error {
  constructor() {
    super('This author has a draft CEO report already.');
    this.name = 'CeoDraftAlreadyThere';
  }
}

export class ClientsCeoReportRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** The reports somebody may list, newest first; their own discarded ones left out. */
  async listFor(scope: CeoReportScope): Promise<CeoReport[]> {
    const rows = await reports(this.db)
      .where((eb) =>
        eb.or([
          ...(scope.authorId === null
            ? []
            : [
                eb.and([eb('r.author_id', '=', scope.authorId), eb('r.status', '<>', 'DISCARDED')]),
              ]),
          ...(scope.everySubmitted ? [eb('r.status', '=', 'SUBMITTED')] : []),
          /* Somebody with nothing in scope lists nothing. */
          eb.val(false),
        ]),
      )
      .orderBy(sql`coalesce(r.submitted_at, r.created_at)`, 'desc')
      .orderBy('r.id', 'desc')
      .execute();

    return rows.map(reportFrom);
  }

  /** One report with its figures, where the scope lets them read it. */
  async findFor(id: string, scope: CeoReportScope): Promise<SavedCeoReport | undefined> {
    const row = await reports(this.db)
      .select(['r.figures', 'r.figures_at', 'r.sections'])
      .where('r.id', '=', id)
      .where((eb) =>
        eb.or([
          ...(scope.authorId === null ? [] : [eb('r.author_id', '=', scope.authorId)]),
          ...(scope.everySubmitted ? [eb('r.status', '=', 'SUBMITTED')] : []),
          eb.val(false),
        ]),
      )
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : {
          ...reportFrom(row),
          ...(row.figures as CeoReportFigures),
          sections: row.sections as ReportSection[],
          figuresAt: row.figures_at,
        };
  }

  /** Whose a report is and its state, nothing of what it says: for writing a refusal down. */
  async subjectOf(
    id: string,
  ): Promise<{ id: string; author: { id: string }; status: CeoReportStatus } | undefined> {
    const row = await this.db
      .selectFrom('clients_ceo_report')
      .select(['id', 'author_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : { id: row.id, author: { id: row.author_id }, status: row.status };
  }

  /** The last day of the report somebody submitted most recently, or null. */
  async lastSubmittedTo(authorId: string): Promise<CalendarDate | null> {
    const row = await this.db
      .selectFrom('clients_ceo_report')
      .select('period_to')
      .where('author_id', '=', authorId)
      .where('status', '=', 'SUBMITTED')
      .orderBy('submitted_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row?.period_to ?? null;
  }

  async draftOf(authorId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('clients_ceo_report')
      .select('id')
      .where('author_id', '=', authorId)
      .where('status', '=', 'DRAFT')
      .executeTakeFirst();

    return row?.id;
  }

  /**
   * The meeting reports shared during a period, on the company's day (UTC), from anybody: their
   * saved counts and what their authors wrote.
   */
  async sharedIn(period: Period): Promise<SharedReport[]> {
    const rows = await this.db
      .selectFrom('clients_meeting_report as m')
      .innerJoin('employee as e', 'e.id', 'm.author_id')
      .select([
        'm.id',
        'm.period_from',
        'm.period_to',
        'm.shared_at',
        'm.figures',
        'm.sections',
        'e.id as author_id',
        sql<string>`e.first_name || ' ' || e.last_name`.as('author_name'),
      ])
      .where('m.status', '=', 'SHARED')
      .where(
        sql<boolean>`(m.shared_at AT TIME ZONE 'UTC')::date
                          BETWEEN ${period.from}::date AND ${period.to}::date`,
      )
      .orderBy('m.shared_at')
      .orderBy('m.id')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      author: { id: row.author_id, name: row.author_name },
      period: { from: row.period_from, to: row.period_to },
      sharedAt: row.shared_at as Date,
      tally: (row.figures as ReportFigures).tally,
      sections: row.sections as ReportSection[],
    }));
  }

  /** A new draft, with its figures and empty sections. Throws {@link CeoDraftAlreadyThere}. */
  async add(
    by: Attribution,
    authorId: string,
    period: Period,
    figures: CeoReportFigures,
    sections: readonly ReportSection[],
  ): Promise<string> {
    try {
      return await recording(this.db, by, async (on) => {
        const row = await on
          .insertInto('clients_ceo_report')
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
        throw new CeoDraftAlreadyThere();
      }
      throw error;
    }
  }

  /** A draft's figures saved afresh, as of now. False where it is no longer a draft. */
  async saveFigures(by: Attribution, id: string, figures: CeoReportFigures): Promise<boolean> {
    return this.changeDraft(by, id, {
      figures: JSON.stringify(figures),
      figures_at: sql<Date>`now()`,
    });
  }

  /** A draft's new period, with its figures for it. False where it is no longer a draft. */
  async changePeriod(
    by: Attribution,
    id: string,
    period: Period,
    figures: CeoReportFigures,
  ): Promise<boolean> {
    return this.changeDraft(by, id, {
      period_from: period.from,
      period_to: period.to,
      figures: JSON.stringify(figures),
      figures_at: sql<Date>`now()`,
    });
  }

  /** A draft's written sections. False where it is no longer a draft. */
  async writeSections(
    by: Attribution,
    id: string,
    sections: readonly ReportSection[],
  ): Promise<boolean> {
    return this.changeDraft(by, id, { sections: JSON.stringify(sections) });
  }

  /** Throws a draft away, keeping it. False where it is no longer a draft. */
  async discard(by: Attribution, id: string): Promise<boolean> {
    return this.changeDraft(by, id, { status: 'DISCARDED', discarded_at: sql<Date>`now()` });
  }

  /**
   * Submits a draft to the Chief Executive: its figures saved a last time and it fixed for good,
   * with the email telling them queued in the same transaction, so it is submitted and told or
   * neither. False where it is no longer a draft, and nothing is queued.
   */
  async submit(
    by: Attribution,
    id: string,
    figures: CeoReportFigures,
    chiefExecutiveId: string,
    email: NewOutboxEmail | null,
  ): Promise<boolean> {
    return recording(this.db, by, async (on) => {
      const rows = await on
        .updateTable('clients_ceo_report')
        .set({
          status: 'SUBMITTED',
          submitted_at: sql<Date>`now()`,
          submitted_to: chiefExecutiveId,
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
      if (email !== null) {
        await new EmailOutboxRepository(on).queue(validateOutboxEmail(email));
      }

      return true;
    });
  }

  private async changeDraft(
    by: Attribution,
    id: string,
    values: UpdateObject<Database, 'clients_ceo_report'>,
  ): Promise<boolean> {
    const rows = await recording(this.db, by, (on) =>
      on
        .updateTable('clients_ceo_report')
        .set(values)
        .where('id', '=', id)
        .where('status', '=', 'DRAFT')
        .returning('id')
        .execute(),
    );

    return rows.length > 0;
  }
}

/** Every CEO report, with its author's name, and its recipient's where it was submitted. */
function reports(db: Kysely<Database>) {
  return db
    .selectFrom('clients_ceo_report as r')
    .innerJoin('employee as e', 'e.id', 'r.author_id')
    .leftJoin('employee as t', 't.id', 'r.submitted_to')
    .select([
      'r.id',
      'r.status',
      'r.created_at',
      'r.submitted_at',
      'r.discarded_at',
      'r.period_from',
      'r.period_to',
      'e.id as author_id',
      sql<string>`e.first_name || ' ' || e.last_name`.as('author_name'),
      't.id as to_id',
      sql<string | null>`t.first_name || ' ' || t.last_name`.as('to_name'),
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof reports>['executeTakeFirstOrThrow']>>;

function reportFrom(row: Row): CeoReport {
  return {
    id: row.id,
    author: { id: row.author_id, name: row.author_name },
    period: { from: row.period_from, to: row.period_to },
    status: row.status,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    submittedTo:
      row.to_id === null || row.to_name === null ? null : { id: row.to_id, name: row.to_name },
    discardedAt: row.discarded_at,
  };
}
