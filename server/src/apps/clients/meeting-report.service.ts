/**
 * Meeting reports: drafting one for a period, reading them, and changing or discarding a draft. #291,
 * Clients SRS CLI 79 to 82.
 *
 * A report's figures are saved with it when the draft is started, and read back as saved, so
 * nothing changed afterwards changes what it says. Its author may update them while it is a draft
 * (the user, 25 November 2026).
 *
 * Anybody with a clients role drafts their own, BD managers included (the user, 25 November
 * 2026). Each is read by its author, and once shared by every BD manager, who is emailed;
 * `clientsPolicy` decides.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { ClientsAccess } from './policy.js';
import type { Guard } from '../../core/auth/policy.js';
import {
  type CalendarDate,
  calendarDateIn,
  currentDate,
  displayTimezone,
} from '../../core/calendar/time.js';
import { renderPdf, reportPdfName, reportSheet } from './meeting-report.pdf.js';
import { accessOf } from './access.js';
import { type ClientsLinks, type Recipient, reportSharedEmail } from './email.js';
import {
  defaultPeriodOf,
  figuresOf,
  freshSections,
  type MeetingReportView,
  MeetingReportDraftOpen,
  MeetingReportNotFound,
  noLongerADraft,
  type MyMeetingReports,
  type Period,
  readPeriod,
  readSections,
} from './meeting-report.js';
import type { ClientsReportContentsRepository } from './meeting-report-contents.db.js';
import {
  type ClientsMeetingReportRepository,
  DraftAlreadyThere,
  type SavedReport,
} from './meeting-report.db.js';
import { clientsPolicy } from './policy.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';

export class MeetingReportService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<
      ClientsRoleRepository,
      'rolesOf' | 'liveSince' | 'liveBdManagers'
    >,
    private readonly reports: Pick<
      ClientsMeetingReportRepository,
      | 'listFor'
      | 'findFor'
      | 'subjectOf'
      | 'lastSharedTo'
      | 'draftOf'
      | 'add'
      | 'saveFigures'
      | 'changePeriod'
      | 'discard'
      | 'share'
      | 'writeSections'
    >,
    /** What a report is built from: its author's work in its period. */
    private readonly contents: Pick<ClientsReportContentsRepository, 'of'>,
    /** Telling BD managers a report is shared: where to link, and nudging the outbox to send. */
    private readonly mail: { links: ClientsLinks; nudge: () => void },
    /** The company's today, which a period ends on at the latest. */
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /**
   * Their own reports, their draft if they have one, and the period a new one is offered; and for
   * a BD manager, everybody else's shared ones. Which reports is the query's, from the policy's
   * scope (NFR CLI SEC 05).
   */
  async mine(actor: Actor): Promise<MyMeetingReports> {
    const access = await accessOf(actor, this.grants);
    const authorId = await this.authorOrRefuse(actor, access);
    const scope = clientsPolicy.meetingReportScope(actor, access);
    if (scope === undefined) {
      throw new Error('Somebody who may draft a report has a scope to list them by.');
    }

    const [listed, draftId, nextPeriod] = await Promise.all([
      this.reports.listFor(scope),
      this.reports.draftOf(authorId),
      this.offered(authorId),
    ]);

    return {
      reports: listed.filter((report) => report.author.id === authorId),
      shared: scope.everyShared ? listed.filter((report) => report.author.id !== authorId) : null,
      draftId: draftId ?? null,
      nextPeriod,
    };
  }

  /**
   * `{ from?, to? }`: a new draft for that period, either day left out being the one offered, with
   * its figures as they stand now. One
   * draft at a time: with one there already, refused with {@link MeetingReportDraftOpen}, which
   * names it for the screen to open.
   */
  async draft(actor: Actor, body: unknown): Promise<MeetingReportView> {
    const access = await accessOf(actor, this.grants);
    const authorId = await this.authorOrRefuse(actor, access);

    const draftId = await this.reports.draftOf(authorId);
    if (draftId !== undefined) {
      throw new MeetingReportDraftOpen(draftId);
    }

    const period = readPeriod(body, await this.offered(authorId), this.today());
    const figures = figuresOf(await this.contents.of(authorId, period));

    let id: string;
    try {
      id = await this.reports.add(actor, authorId, period, figures, freshSections());
    } catch (error) {
      /* Another started between the look and the write: that one is the draft. */
      if (error instanceof DraftAlreadyThere) {
        const now = await this.reports.draftOf(authorId);
        if (now !== undefined) throw new MeetingReportDraftOpen(now);
      }
      throw error;
    }

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * One report, to whoever may read it, with its figures as saved: its author's activities, deals'
   * stage changes, next steps and POCs in its period, and the counts on top.
   */
  async read(actor: Actor, id: string): Promise<MeetingReportView> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * One report as a PDF, to whoever may open it, a draft included, which says so (the user, 25
   * November 2026). The same report its page shows, as saved.
   */
  async pdf(actor: Actor, id: string): Promise<{ name: string; bytes: Buffer }> {
    const report = await this.read(actor, id);
    const sheet = reportSheet(report, displayTimezone());

    return {
      name: reportPdfName(report),
      bytes: await renderPdf(sheet),
    };
  }

  /**
   * Saves a draft's figures afresh, as its author's work in its period stands now. Its author's
   * alone, and refused once it is shared or discarded.
   */
  async updateFigures(actor: Actor, id: string): Promise<MeetingReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const figures = figuresOf(await this.contents.of(report.author.id, report.period));
    await this.stillADraft(actor, access, id, await this.reports.saveFigures(actor, id, figures));

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * `{ from?, to? }`: a draft's new period, either day left out staying as it is, with its figures
   * saved afresh for it (the user, 25 November 2026). Never ends after today, and never starts
   * after it ends. The same period changes nothing.
   */
  async change(actor: Actor, id: string, body: unknown): Promise<MeetingReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const period = readPeriod(body, report.period, this.today());
    if (period.from === report.period.from && period.to === report.period.to) {
      return viewOf(actor, access, report);
    }

    const figures = figuresOf(await this.contents.of(report.author.id, period));
    await this.stillADraft(
      actor,
      access,
      id,
      await this.reports.changePeriod(actor, id, period, figures),
    );

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * `{ sections: { [key]: text | null } }`: what its author writes in a draft's sections, those
   * left out kept as they are. Each may be empty, and none is needed to share it (the user, 25
   * November 2026).
   */
  async writeSections(actor: Actor, id: string, body: unknown): Promise<MeetingReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const sections = readSections(body, report.sections);
    await this.stillADraft(
      actor,
      access,
      id,
      await this.reports.writeSections(actor, id, sections),
    );

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * Throws a draft away, which frees its author to start another (the user, 25 November 2026). It
   * is kept, out of their list, as nothing in clients is deleted.
   */
  async discard(actor: Actor, id: string): Promise<MeetingReportView> {
    const { access } = await this.draftToChange(actor, id);

    await this.stillADraft(actor, access, id, await this.reports.discard(actor, id));

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * Shares a draft: its figures saved a last time, as its author's work in its period stands now,
   * and it fixed for good; every BD manager may then read it, and each is emailed, the author
   * aside (the user, 25 November 2026).
   */
  async share(actor: Actor, id: string): Promise<MeetingReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const figures = figuresOf(await this.contents.of(report.author.id, report.period));
    const emails = (await this.grants.liveBdManagers())
      .filter((bdManager: Recipient) => bdManager.id !== report.author.id)
      .map((bdManager) =>
        reportSharedEmail({ bdManager, report, tally: figures.tally, links: this.mail.links }),
      );

    await this.stillADraft(actor, access, id, await this.reports.share(actor, id, figures, emails));
    if (emails.length > 0) {
      this.mail.nudge();
    }

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /** A report its author may change: theirs, and still a draft. */
  private async draftToChange(
    actor: Actor,
    id: string,
  ): Promise<{ access: ClientsAccess; report: SavedReport }> {
    const access = await accessOf(actor, this.grants);
    this.guard.enforce(clientsPolicy.read(actor, access, id));

    const report = await this.found(actor, access, id);
    this.guard.enforce(clientsPolicy.writeMeetingReport(actor, access, report));

    if (report.status !== 'DRAFT') {
      throw noLongerADraft(report.status);
    }

    return { access, report };
  }

  /** Where a write found it no longer a draft, shared or discarded between the look and the write. */
  private async stillADraft(
    actor: Actor,
    access: ClientsAccess,
    id: string,
    written: boolean,
  ): Promise<void> {
    if (!written) {
      throw noLongerADraft((await this.found(actor, access, id)).status);
    }
  }

  /** Who is asking, where they may draft a report of their own. */
  private async authorOrRefuse(actor: Actor, given?: ClientsAccess): Promise<string> {
    const access = given ?? (await accessOf(actor, this.grants));
    this.guard.enforce(clientsPolicy.contribute(actor, access, 'draftMeetingReport'));

    /* Holding a role means being somebody: the system holds none. */
    return actor.employeeId as string;
  }

  /** The period a new report of theirs is offered. */
  private async offered(authorId: string): Promise<Period> {
    const today = this.today();
    const [lastSharedTo, since] = await Promise.all([
      this.reports.lastSharedTo(authorId),
      this.grants.liveSince(authorId),
    ]);

    return defaultPeriodOf(
      lastSharedTo,
      since === undefined ? today : calendarDateIn(since, 'UTC'),
      today,
    );
  }

  /**
   * One report, found by a query that finds only what they may read (NFR CLI SEC 05): their own,
   * and for a BD manager every shared one. Anything else answers as if it were not there, the same
   * as an id nobody has, and where it is there the refusal is written down (the user, 25 November
   * 2026).
   */
  private async found(actor: Actor, access: ClientsAccess, id: string): Promise<SavedReport> {
    const scope = clientsPolicy.meetingReportScope(actor, access);
    const report =
      scope === undefined || !isAnId(id) ? undefined : await this.reports.findFor(id, scope);

    if (report === undefined) {
      const hidden = isAnId(id) ? await this.reports.subjectOf(id) : undefined;
      if (hidden !== undefined) {
        const decision = clientsPolicy.readMeetingReport(actor, access, hidden);
        if (!decision.allowed) {
          this.guard.record(decision);
        }
      }
      throw new MeetingReportNotFound();
    }

    /* The policy agrees with the query; asked as well, so the two can never drift apart. */
    this.guard.enforce(clientsPolicy.readMeetingReport(actor, access, report));

    return report;
  }
}

/** A report as somebody reads it: whether they may change it is the policy's answer. */
function viewOf(actor: Actor, access: ClientsAccess, report: SavedReport): MeetingReportView {
  return {
    ...report,
    may: {
      change:
        report.status === 'DRAFT' &&
        clientsPolicy.writeMeetingReport(actor, access, report).allowed,
    },
  };
}
