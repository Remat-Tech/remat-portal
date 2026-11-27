/**
 * CEO reports: a BD manager drafting one for a period, changing and submitting it, and the Chief
 * Executive reading what was submitted. #292, Clients SRS CLI 83.
 *
 * Built from the meeting reports shared during its period and the pipeline as it stands, saved
 * with it as the draft starts, updated by its author while a draft, and saved a last time as it is
 * submitted. Nothing is sent to anybody but by its author submitting it (#292), and with nobody
 * named as the Chief Executive it is not submitted.
 */

import type { Actor } from '../../core/auth/actor.js';
import type { Guard } from '../../core/auth/policy.js';
import { type CalendarDate, currentDate, displayTimezone } from '../../core/calendar/time.js';
import type { EmployeeRepository } from '../../core/organisation/employee/employee.db.js';
import { accessOf, type ChiefExecutive } from './access.js';
import {
  type CeoPipeline,
  type CeoReport,
  CeoReportDraftOpen,
  type CeoReportFigures,
  CeoReportNotFound,
  type CeoReportView,
  defaultCeoPeriodOf,
  freshCeoSections,
  InvalidCeoReport,
  type MyCeoReports,
  NoChiefExecutive,
  noLongerACeoDraft,
  teamOf,
} from './ceo-report.js';
import {
  CeoDraftAlreadyThere,
  type ClientsCeoReportRepository,
  type SavedCeoReport,
} from './ceo-report.db.js';
import { renderCeoPdf, ceoPdfName, ceoReportSheet } from './ceo-report.pdf.js';
import type { DashboardService } from './dashboard.service.js';
import { type ClientsLinks, ceoReportEmail } from './email.js';
import { type Invalid, type Period, readPeriod, readSections } from './meeting-report.js';
import { type ClientsAccess, clientsPolicy } from './policy.js';
import { POC_HEALTHS } from './poc.js';
import { isAnId } from './product.js';
import type { ClientsRoleRepository } from './role.db.js';

const invalid: Invalid = (field, message) => new InvalidCeoReport(field, message);

/** What a list of CEO reports holds for whoever asks. */
export interface CeoReportsList {
  /** A BD manager's own, their draft and the period a new one is offered; null for anybody else. */
  mine: MyCeoReports | null;
  /** Every submitted one, newest first, for the Chief Executive; null for anybody else. */
  received: CeoReport[] | null;
}

export class CeoReportService {
  constructor(
    private readonly guard: Guard,
    private readonly grants: Pick<ClientsRoleRepository, 'rolesOf'>,
    private readonly reports: Pick<
      ClientsCeoReportRepository,
      | 'listFor'
      | 'findFor'
      | 'subjectOf'
      | 'lastSubmittedTo'
      | 'draftOf'
      | 'sharedIn'
      | 'add'
      | 'saveFigures'
      | 'changePeriod'
      | 'writeSections'
      | 'discard'
      | 'submit'
    >,
    /** The pipeline as it stands, as the dashboard shows it. */
    private readonly dashboard: Pick<DashboardService, 'dashboard'>,
    /** Whoever the organisation names as its Chief Executive. */
    private readonly chiefExecutive: ChiefExecutive,
    private readonly employees: Pick<EmployeeRepository, 'findById'>,
    /** Telling the Chief Executive: where to link, and nudging the outbox to send. */
    private readonly mail: { links: ClientsLinks; nudge: () => void },
    private readonly today: () => CalendarDate = () => currentDate(),
  ) {}

  /** A BD manager's own reports, and for the Chief Executive every one submitted. */
  async list(actor: Actor): Promise<CeoReportsList> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.enterCeoReports(actor, access));

    const scope = clientsPolicy.ceoReportScope(actor, access);
    if (scope === undefined) {
      return { mine: null, received: null };
    }

    const listed = await this.reports.listFor(scope);
    let mine: MyCeoReports | null = null;
    if (scope.authorId !== null) {
      const authorId = scope.authorId;
      const [draftId, nextPeriod] = await Promise.all([
        this.reports.draftOf(authorId),
        this.offered(authorId),
      ]);
      mine = {
        reports: listed.filter((report) => report.author.id === authorId),
        draftId: draftId ?? null,
        nextPeriod,
      };
    }

    return {
      mine,
      received: scope.everySubmitted
        ? listed.filter((report) => report.status === 'SUBMITTED')
        : null,
    };
  }

  /**
   * `{ from?, to? }`: a new draft for that period, either day left out being the one offered, its
   * figures as they stand now. A BD manager's. One draft at a time.
   */
  async draft(actor: Actor, body: unknown): Promise<CeoReportView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.ceoReport(actor, access));
    const authorId = actor.employeeId as string;

    const draftId = await this.reports.draftOf(authorId);
    if (draftId !== undefined) {
      throw new CeoReportDraftOpen(draftId);
    }

    const period = readPeriod(body, await this.offered(authorId), this.today(), invalid);
    const figures = await this.figuresFor(actor, period);

    let id: string;
    try {
      id = await this.reports.add(actor, authorId, period, figures, freshCeoSections());
    } catch (error) {
      if (error instanceof CeoDraftAlreadyThere) {
        const now = await this.reports.draftOf(authorId);
        if (now !== undefined) throw new CeoReportDraftOpen(now);
      }
      throw error;
    }

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /** One report, to whoever may read it, as saved. */
  async read(actor: Actor, id: string): Promise<CeoReportView> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.enterCeoReports(actor, access));

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /** One report as a PDF, to whoever may read it, a draft marked as one. */
  async pdf(actor: Actor, id: string): Promise<{ name: string; bytes: Buffer }> {
    const report = await this.read(actor, id);

    return {
      name: ceoPdfName(report),
      bytes: await renderCeoPdf(ceoReportSheet(report, displayTimezone())),
    };
  }

  /** Saves a draft's figures afresh. Its author's alone, while a draft. */
  async updateFigures(actor: Actor, id: string): Promise<CeoReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const figures = await this.figuresFor(actor, report.period);
    await this.stillADraft(actor, access, id, await this.reports.saveFigures(actor, id, figures));

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /** `{ from?, to? }`: a draft's new period, its figures saved afresh for it. */
  async change(actor: Actor, id: string, body: unknown): Promise<CeoReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const period = readPeriod(body, report.period, this.today(), invalid);
    if (period.from === report.period.from && period.to === report.period.to) {
      return viewOf(actor, access, report);
    }

    const figures = await this.figuresFor(actor, period);
    await this.stillADraft(
      actor,
      access,
      id,
      await this.reports.changePeriod(actor, id, period, figures),
    );

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /** `{ sections: { [key]: text | null } }`: what its author writes, those left out kept. */
  async writeSections(actor: Actor, id: string, body: unknown): Promise<CeoReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const sections = readSections(body, report.sections, invalid);
    await this.stillADraft(
      actor,
      access,
      id,
      await this.reports.writeSections(actor, id, sections),
    );

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /** Throws a draft away, keeping it, which frees its author to start another. */
  async discard(actor: Actor, id: string): Promise<CeoReportView> {
    const { access } = await this.draftToChange(actor, id);

    await this.stillADraft(actor, access, id, await this.reports.discard(actor, id));

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /**
   * Submits a draft to the Chief Executive: its figures saved a last time, it fixed for good,
   * and them emailed, all at once. Refused with nobody named as the Chief Executive, when it
   * stays a draft (the user, 27 November 2026). The only way anything is sent (#292).
   */
  async submit(actor: Actor, id: string): Promise<CeoReportView> {
    const { access, report } = await this.draftToChange(actor, id);

    const chiefId = await this.chiefExecutive();
    const chief = chiefId === null ? undefined : await this.employees.findById(chiefId);
    if (chiefId === null || chief === undefined) {
      throw new NoChiefExecutive();
    }

    const figures = await this.figuresFor(actor, report.period);
    /* A BD manager who is also the Chief Executive is not emailed about their own. */
    const email =
      chief.id === report.author.id
        ? null
        : ceoReportEmail({
            ceo: { id: chief.id, firstName: chief.firstName, workEmail: chief.workEmail },
            report,
            figures,
            links: this.mail.links,
          });

    await this.stillADraft(
      actor,
      access,
      id,
      await this.reports.submit(actor, id, figures, chief.id, email),
    );
    if (email !== null) {
      this.mail.nudge();
    }

    return viewOf(actor, access, await this.found(actor, access, id));
  }

  /* ------------------------------------------------------------------------------------ */

  private accessOf(actor: Actor): Promise<ClientsAccess> {
    return accessOf(actor, this.grants, this.chiefExecutive);
  }

  /** The team, the associates' words and the pipeline, as they stand now, for a period. */
  private async figuresFor(actor: Actor, period: Period): Promise<CeoReportFigures> {
    const [shared, dashboard] = await Promise.all([
      this.reports.sharedIn(period),
      this.dashboard.dashboard(actor),
    ]);

    const pipeline: CeoPipeline = {
      recorded: dashboard.totals.recorded,
      opportunities: dashboard.totals.opportunities,
      clients: dashboard.totals.clients,
      noValue: dashboard.totals.noValue,
      stages: dashboard.stages.map(({ stage, opportunities, recorded, noValue }) => ({
        stage,
        opportunities,
        recorded,
        noValue,
      })),
      pocs: dashboard.pocs.health,
      pocsTotal: POC_HEALTHS.reduce((total, health) => total + dashboard.pocs.health[health], 0),
    };

    return { ...teamOf(shared), pipeline };
  }

  /** A report its author may change: theirs, and still a draft. */
  private async draftToChange(
    actor: Actor,
    id: string,
  ): Promise<{ access: ClientsAccess; report: SavedCeoReport }> {
    const access = await this.accessOf(actor);
    this.guard.enforce(clientsPolicy.enterCeoReports(actor, access));

    const report = await this.found(actor, access, id);
    this.guard.enforce(clientsPolicy.writeCeoReport(actor, access, report));

    if (report.status !== 'DRAFT') {
      throw noLongerACeoDraft(report.status);
    }

    return { access, report };
  }

  /** Where a write found it no longer a draft, submitted or discarded meanwhile. */
  private async stillADraft(
    actor: Actor,
    access: ClientsAccess,
    id: string,
    written: boolean,
  ): Promise<void> {
    if (!written) {
      throw noLongerACeoDraft((await this.found(actor, access, id)).status);
    }
  }

  /** The period a new report of theirs is offered. */
  private async offered(authorId: string): Promise<Period> {
    return defaultCeoPeriodOf(await this.reports.lastSubmittedTo(authorId), this.today());
  }

  /**
   * One report, found by a query that finds only what they may read. Anything else answers as if
   * it were not there, and where it is there the refusal is written down.
   */
  private async found(actor: Actor, access: ClientsAccess, id: string): Promise<SavedCeoReport> {
    const scope = clientsPolicy.ceoReportScope(actor, access);
    const report =
      scope === undefined || !isAnId(id) ? undefined : await this.reports.findFor(id, scope);

    if (report === undefined) {
      const hidden = isAnId(id) ? await this.reports.subjectOf(id) : undefined;
      if (hidden !== undefined) {
        const decision = clientsPolicy.readCeoReport(actor, access, hidden);
        if (!decision.allowed) {
          this.guard.record(decision);
        }
      }
      throw new CeoReportNotFound();
    }

    this.guard.enforce(clientsPolicy.readCeoReport(actor, access, report));

    return report;
  }
}

/** A report as somebody reads it: whether they may change it is the policy's answer. */
function viewOf(actor: Actor, access: ClientsAccess, report: SavedCeoReport): CeoReportView {
  return {
    ...report,
    may: {
      change:
        report.status === 'DRAFT' && clientsPolicy.writeCeoReport(actor, access, report).allowed,
    },
  };
}
