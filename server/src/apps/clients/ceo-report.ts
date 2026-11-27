/**
 * The report to the CEO: a BD manager's, for a period. #292, Clients SRS CLI 83.
 *
 * The same model as a meeting report (#291, the user, 27 November 2026), one level up. Each BD
 * manager drafts their own, one at a time, for a period offered from the day after the last one
 * they submitted, or from the 1st of the month for a first. It holds, as saved:
 *
 * - **the team**: a row per associate from the saved figures of the meeting reports they shared
 *   during the period, and the totals;
 * - **the pipeline as it stands** when the figures are saved: the value recorded per currency,
 *   open deals, clients, deals by stage, and running POCs by health;
 * - **the associates' own words**: each of those reports' written sections, under their name;
 * - **the BD manager's own sections**: placeholders until the team confirms what it holds.
 *
 * Submitting fixes it and sends it to whoever the organisation names as its Chief Executive. With
 * nobody named, it is not submitted. Nothing is sent but by its author submitting it.
 */

import { type CalendarDate, dayAfter } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import type { Money } from './opportunity.js';
import type { Period, ReportSection, ReportTally } from './meeting-report.js';
import type { PocHealth } from './poc.js';
import type { Stage } from './stage.js';

export type CeoReportStatus = 'DRAFT' | 'SUBMITTED' | 'DISCARDED';

export interface CeoReport {
  id: string;
  author: Person;
  period: Period;
  status: CeoReportStatus;
  createdAt: Date;
  /** When it was submitted, and to whom, or null while it is a draft. */
  submittedAt: Date | null;
  submittedTo: Person | null;
  /** When its author discarded it, or null. */
  discardedAt: Date | null;
}

/** One associate's line of the team table: what their reports shared in the period add up to. */
export interface TeamRow {
  author: Person;
  /** How many of their meeting reports were shared in the period. */
  reports: number;
  activities: number;
  stageMoves: number;
  stepsDone: number;
  stepsOverdue: number;
  pocs: number;
}

export type TeamTotals = Omit<TeamRow, 'author'>;

/** A meeting report shared in the period, with what its author wrote. */
export interface SharedWords {
  reportId: string;
  author: Person;
  period: Period;
  /** When it was shared, as an ISO instant: saved with the figures as text. */
  sharedAt: string;
  sections: ReportSection[];
}

/** The pipeline as it stood when the figures were saved: the dashboard's own figures. */
export interface CeoPipeline {
  recorded: Money[];
  opportunities: number;
  clients: number;
  /** Open deals with no value recorded, which no total counts (CLI 77). */
  noValue: number;
  stages: { stage: Stage; opportunities: number; recorded: Money[]; noValue: number }[];
  pocs: Record<PocHealth, number>;
  pocsTotal: number;
}

/** What a CEO report is built from, saved with it so that nothing done later changes it. */
export interface CeoReportFigures {
  team: TeamRow[];
  totals: TeamTotals;
  words: SharedWords[];
  pipeline: CeoPipeline;
}

/** A report, with its saved figures and sections, and what the reader may do to it. */
export type CeoReportView = CeoReport &
  CeoReportFigures & {
    sections: ReportSection[];
    figuresAt: Date;
    may: {
      /** Update its figures, change its period and sections, discard or submit it. */
      change: boolean;
    };
  };

/** Somebody's own CEO reports, and what starting another would do. A BD manager's. */
export interface MyCeoReports {
  /** Newest first, discarded ones left out. */
  reports: CeoReport[];
  draftId: string | null;
  nextPeriod: Period;
}

/**
 * The BD manager's written sections, until the team confirms what a CEO report holds (the user,
 * 27 November 2026): placeholders, copied onto each draft as it starts. Each may be left empty.
 */
export const CEO_REPORT_SECTIONS = [
  { key: 'HIGHLIGHTS', heading: 'Highlights' },
  { key: 'RISKS', heading: 'Risks and where I need support' },
  { key: 'OUTLOOK', heading: 'Outlook for the next period' },
  { key: 'OTHER', heading: 'Anything else' },
] as const;

export function freshCeoSections(): ReportSection[] {
  return CEO_REPORT_SECTIONS.map(({ key, heading }) => ({ key, heading, body: null }));
}

/** A period or sections that make no sense, naming the field to fix. */
export class InvalidCeoReport extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidCeoReport';
    this.field = field;
  }
}

export class CeoReportNotFound extends Error {
  constructor() {
    super('No CEO report matches that. Refresh the page to see the reports as they are now.');
    this.name = 'CeoReportNotFound';
  }
}

/** One draft at a time: the one there is, which the screen opens instead. */
export class CeoReportDraftOpen extends Error {
  readonly draftId: string;

  constructor(draftId: string) {
    super('You have a draft CEO report already. Submit or discard it before starting another.');
    this.name = 'CeoReportDraftOpen';
    this.draftId = draftId;
  }
}

export class CeoReportSubmitted extends Error {
  constructor() {
    super('This report has been submitted to the CEO, so it stays as it was submitted.');
    this.name = 'CeoReportSubmitted';
  }
}

export class CeoReportDiscarded extends Error {
  constructor() {
    super('This draft was discarded, so it stays as it was.');
    this.name = 'CeoReportDiscarded';
  }
}

/** Nobody to send it to (the user, 27 November 2026): it stays a draft. */
export class NoChiefExecutive extends Error {
  constructor() {
    super(
      'Nobody is named as the Chief Executive in the organisation settings. Ask a system ' +
        'administrator to name them, then submit it.',
    );
    this.name = 'NoChiefExecutive';
  }
}

/** The refusal for changing a report that is no longer a draft. */
export function noLongerACeoDraft(status: CeoReportStatus): Error {
  return status === 'DISCARDED' ? new CeoReportDiscarded() : new CeoReportSubmitted();
}

/**
 * The period a new CEO report is offered: from the day after the period of the one its author
 * submitted last, or with none submitted from the 1st of the month; to today. A start after
 * today, where the last one ran to today, is today.
 */
export function defaultCeoPeriodOf(
  lastSubmittedTo: CalendarDate | null,
  today: CalendarDate,
): Period {
  const from = lastSubmittedTo === null ? `${today.slice(0, 8)}01` : dayAfter(lastSubmittedTo);

  return { from: from > today ? today : from, to: today };
}

/** A meeting report shared in the period, as a CEO report reads it: its counts and its words. */
export interface SharedReport {
  id: string;
  author: Person;
  period: Period;
  sharedAt: Date;
  tally: ReportTally;
  sections: ReportSection[];
}

/**
 * The team table and the associates' words, from the meeting reports shared in the period. A row
 * per author, A to Z; the words in the order they were shared.
 */
export function teamOf(shared: readonly SharedReport[]): Omit<CeoReportFigures, 'pipeline'> {
  const rows = new Map<string, TeamRow>();

  for (const report of shared) {
    const row = rows.get(report.author.id) ?? {
      author: report.author,
      reports: 0,
      activities: 0,
      stageMoves: 0,
      stepsDone: 0,
      stepsOverdue: 0,
      pocs: 0,
    };

    row.reports += 1;
    row.activities += report.tally.activitiesTotal;
    row.stageMoves += report.tally.stageMoves;
    row.stepsDone += report.tally.stepsDone;
    row.stepsOverdue += report.tally.stepsOverdue;
    row.pocs += report.tally.pocsTotal;
    rows.set(report.author.id, row);
  }

  const team = [...rows.values()].sort((one, other) =>
    one.author.name.localeCompare(other.author.name),
  );

  return {
    team,
    totals: {
      reports: sum(team, (row) => row.reports),
      activities: sum(team, (row) => row.activities),
      stageMoves: sum(team, (row) => row.stageMoves),
      stepsDone: sum(team, (row) => row.stepsDone),
      stepsOverdue: sum(team, (row) => row.stepsOverdue),
      pocs: sum(team, (row) => row.pocs),
    },
    words: [...shared]
      .sort((one, other) => one.sharedAt.getTime() - other.sharedAt.getTime())
      .map((report) => ({
        reportId: report.id,
        author: report.author,
        period: report.period,
        sharedAt: report.sharedAt.toISOString(),
        sections: report.sections,
      })),
  };
}

/** "GHS 1,250,000.00": minor units in words, one currency, never added to another (CLI 75). */
export function moneyInWords(money: Money): string {
  return `${money.currency} ${(money.amountMinor / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function sum(rows: readonly TeamRow[], value: (row: TeamRow) => number): number {
  return rows.reduce((total, row) => total + value(row), 0);
}
