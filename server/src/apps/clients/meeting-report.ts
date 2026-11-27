/**
 * Meeting reports: what somebody brings to their meeting with a BD manager, for a period. #291,
 * Clients SRS CLI 79 to CLI 82.
 *
 * A report covers a period, both days included. The period offered starts the day after the one
 * its author shared last, or for a first report the day their clients role began, and ends today
 * (the user, 25 November 2026). Periods may overlap. One draft each at a time.
 */

import { type CalendarDate, dayAfter, isCalendarDate } from '../../core/calendar/time.js';
import type { Person } from './client.js';
import { ACTIVITY_KINDS, type ActivityKind, fieldsOf } from './logged-activity.js';
import type { Outcome } from './opportunity.js';
import { POC_HEALTHS, type PocHealth } from './poc.js';
import type { Stage } from './stage.js';

/** A draft, until it is shared, or discarded by its author (the user, 25 November 2026). */
export type MeetingReportStatus = 'DRAFT' | 'SHARED' | 'DISCARDED';

export interface Period {
  /** The first day it covers. */
  from: CalendarDate;
  /** The last day it covers, today at the latest. */
  to: CalendarDate;
}

export interface MeetingReport {
  id: string;
  author: Person;
  period: Period;
  status: MeetingReportStatus;
  createdAt: Date;
  /** When it was shared, or null while it is a draft. */
  sharedAt: Date | null;
  /** When its author discarded it, or null. */
  discardedAt: Date | null;
}

/** Somebody's own reports, and what starting another would do. */
export interface MyMeetingReports {
  /** Their own, newest first, discarded ones left out. */
  reports: MeetingReport[];
  /** For a BD manager, everybody else's shared reports, newest shared first. Null for anybody else. */
  shared: MeetingReport[] | null;
  /** Their draft, which starting another opens instead, or null. */
  draftId: string | null;
  /** The period a new report is offered. */
  nextPeriod: Period;
}

/** A period that makes no sense, naming the field to fix. */
export class InvalidMeetingReport extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidMeetingReport';
    this.field = field;
  }
}

export class MeetingReportNotFound extends Error {
  constructor() {
    super('No meeting report matches that. Refresh the page to see the reports as they are now.');
    this.name = 'MeetingReportNotFound';
  }
}

/** Shared, and so fixed for good (TDD 4.7). */
export class MeetingReportShared extends Error {
  constructor() {
    super('This report has been shared, so it stays as it was shared.');
    this.name = 'MeetingReportShared';
  }
}

/** Discarded, and so kept as it was. */
export class MeetingReportDiscarded extends Error {
  constructor() {
    super('This draft was discarded, so it stays as it was.');
    this.name = 'MeetingReportDiscarded';
  }
}

/** The refusal for changing a report that is no longer a draft. */
export function noLongerADraft(status: MeetingReportStatus): Error {
  return status === 'DISCARDED' ? new MeetingReportDiscarded() : new MeetingReportShared();
}

/** One draft at a time: the one there is, which the screen opens instead. */
export class MeetingReportDraftOpen extends Error {
  readonly draftId: string;

  constructor(draftId: string) {
    super('You have a draft report already. Finish and share it before starting another.');
    this.name = 'MeetingReportDraftOpen';
    this.draftId = draftId;
  }
}

/**
 * The period a new report is offered: from the day after the period of the report shared last,
 * or, with none shared, from the day the author's clients role began; to today. A start after
 * today, where the last one shared ran to today, is today.
 */
export function defaultPeriodOf(
  lastSharedTo: CalendarDate | null,
  roleBegan: CalendarDate,
  today: CalendarDate,
): Period {
  const from = lastSharedTo === null ? roleBegan : dayAfter(lastSharedTo);

  return { from: from > today ? today : from, to: today };
}

/**
 * `{ from?, to? }`, from a request body: either left out is the period offered. Never ends after
 * today, and never starts after it ends.
 */
/** Makes the error a report's own reader throws, naming the field to fix. */
export type Invalid = (field: string, message: string) => Error;

const invalidMeetingReport: Invalid = (field, message) => new InvalidMeetingReport(field, message);

export function readPeriod(
  body: unknown,
  offered: Period,
  today: CalendarDate,
  invalid: Invalid = invalidMeetingReport,
): Period {
  const fields = fieldsOf(body);
  const from = readDay(fields.from, 'from', offered.from, 'the first day it covers', invalid);
  const to = readDay(fields.to, 'to', offered.to, 'the last day it covers', invalid);

  if (to > today) {
    throw invalid('to', 'That day has not come yet. End it today or earlier.');
  }
  if (from > to) {
    throw invalid('from', 'Start it on or before the day it ends.');
  }

  return { from, to };
}

function readDay(
  value: unknown,
  field: string,
  offered: CalendarDate,
  what: string,
  invalid: Invalid,
): CalendarDate {
  if (value === undefined || value === null || value === '') {
    return offered;
  }
  if (!isCalendarDate(value)) {
    throw invalid(field, `Give ${what} as a date.`);
  }

  return value;
}

/* ------------------------------------------------------------------ what it holds, #291 */

/** A client, or one of its deals, as a report line names it. */
export interface ReportDeal {
  id: string;
  /** The product's name: "CreditStudio". */
  product: string;
}

/** An activity they logged that happened in the period. */
export interface ReportActivity {
  id: string;
  happenedOn: CalendarDate;
  kind: ActivityKind;
  client: Person;
  deal: ReportDeal | null;
  withWhom: string | null;
  outcome: string | null;
}

/**
 * A stage change in the period on a deal they own, whoever made it. The row that opens a deal has
 * no `from`; the row that ends one where it stands has `from` equal to `to` and says its outcome.
 */
export interface ReportStageMove {
  id: string;
  /** The company's day it was made. */
  movedOn: CalendarDate;
  client: Person;
  deal: ReportDeal;
  from: Stage | null;
  to: Stage;
  outcome: Outcome;
  note: string | null;
  by: Person;
}

/** One of their next steps: closed in the period, or still open and past due at its end. */
export interface ReportStep {
  id: string;
  description: string;
  client: Person;
  deal: ReportDeal | null;
  dueOn: CalendarDate;
  /** The company's day it was closed, or null for one still open at the period's end. */
  doneOn: CalendarDate | null;
}

/** A health a POC was set to in the period. */
export interface ReportHealthChange {
  health: PocHealth;
  setOn: CalendarDate;
  note: string | null;
  by: Person;
}

/** A POC they lead that ran during the period. */
export interface ReportPoc {
  id: string;
  client: Person;
  /** The product line it runs on: "Symphony". */
  line: string;
  startedOn: CalendarDate;
  decisionOn: CalendarDate;
  /** Its health on the period's last day. Every POC has one from the day it starts. */
  healthAtEnd: PocHealth;
  /** Oldest first. */
  changes: ReportHealthChange[];
  /** How it ended, where it ended by the period's last day: its deal's outcome. Else null. */
  ended: { outcome: Outcome; on: CalendarDate } | null;
}

/** What a report is built from, for its period. */
export interface ReportContents {
  activities: ReportActivity[];
  stageMoves: ReportStageMove[];
  stepsDone: ReportStep[];
  stepsOverdue: ReportStep[];
  pocs: ReportPoc[];
}

/** The counts on top of a report. */
export interface ReportTally {
  /** Every kind, a zero included, in the order the activity list offers them. */
  activities: { kind: ActivityKind; count: number }[];
  activitiesTotal: number;
  stageMoves: number;
  stepsDone: number;
  stepsOverdue: number;
  /** POCs by their health at the period's end. */
  pocs: Record<PocHealth, number>;
  pocsTotal: number;
}

/**
 * What a report holds and the counts on top, saved with it as they stood at one moment (the user,
 * 25 November 2026), so that nothing changed afterwards changes what it said.
 */
export interface ReportFigures {
  contents: ReportContents;
  tally: ReportTally;
}

/**
 * The written sections a report has, until the team confirms what it holds (the user, 25 November
 * 2026): placeholders, copied onto each draft as it starts, so changing this list changes no
 * report already started. Each may be left empty.
 */
export const REPORT_SECTIONS = [
  { key: 'PROGRESS', heading: 'Progress and wins' },
  { key: 'BLOCKERS', heading: 'Blockers and where I need help' },
  { key: 'NEXT_PERIOD', heading: 'Plan for the next period' },
  { key: 'OTHER', heading: 'Anything else' },
] as const;

/** The most a section may hold. */
export const MAX_SECTION_LENGTH = 4000;

/** One written section, as a report holds it. */
export interface ReportSection {
  key: string;
  heading: string;
  /** What its author wrote, or null where nothing is. */
  body: string | null;
}

/** A new draft's sections: the headings there are now, each empty. */
export function freshSections(): ReportSection[] {
  return REPORT_SECTIONS.map(({ key, heading }) => ({ key, heading, body: null }));
}

/**
 * `{ sections: { [key]: text | null } }`, from a request body: the report's own sections, each
 * named one given new words, blank or null emptying it, those left out kept as they are. A key
 * the report has no section for is refused.
 */
export function readSections(
  body: unknown,
  current: readonly ReportSection[],
  invalid: Invalid = invalidMeetingReport,
): ReportSection[] {
  const given = fieldsOf(body).sections;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw invalid('sections', 'Say what to write in each section.');
  }

  const asked = given as Record<string, unknown>;
  for (const key of Object.keys(asked)) {
    if (!current.some((section) => section.key === key)) {
      throw invalid(`sections.${key}`, 'This report has no such section.');
    }
  }

  return current.map((section) => {
    if (!(section.key in asked)) {
      return section;
    }

    const value = asked[section.key];
    if (value !== null && typeof value !== 'string') {
      throw invalid(`sections.${section.key}`, `Write ${section.heading} as text.`);
    }

    const text = (value ?? '').trim();
    if (text.length > MAX_SECTION_LENGTH) {
      throw invalid(
        `sections.${section.key}`,
        `Keep ${section.heading} to ${String(MAX_SECTION_LENGTH)} characters.`,
      );
    }

    return { ...section, body: text === '' ? null : text };
  });
}

/** A report, with its saved figures, when they were saved, and what the reader may do to it. */
export type MeetingReportView = MeetingReport &
  ReportFigures & {
    /** Its written sections, in order. */
    sections: ReportSection[];
    figuresAt: Date;
    may: {
      /** Update its figures, and later change and share it: its author's, while a draft. */
      change: boolean;
    };
  };

/** The figures a report saves, from what it holds. */
export function figuresOf(contents: ReportContents): ReportFigures {
  return { contents, tally: tallyOf(contents) };
}

export function tallyOf(contents: ReportContents): ReportTally {
  const pocs = Object.fromEntries(POC_HEALTHS.map((health) => [health, 0])) as Record<
    PocHealth,
    number
  >;
  for (const poc of contents.pocs) {
    pocs[poc.healthAtEnd] += 1;
  }

  return {
    activities: ACTIVITY_KINDS.map((kind) => ({
      kind,
      count: contents.activities.filter((activity) => activity.kind === kind).length,
    })),
    activitiesTotal: contents.activities.length,
    stageMoves: contents.stageMoves.length,
    stepsDone: contents.stepsDone.length,
    stepsOverdue: contents.stepsOverdue.length,
    pocs,
    pocsTotal: contents.pocs.length,
  };
}
