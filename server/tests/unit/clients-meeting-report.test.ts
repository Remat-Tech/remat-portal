import { describe, expect, it } from 'vitest';
import {
  defaultPeriodOf,
  freshSections,
  InvalidMeetingReport,
  readPeriod,
  readSections,
  type ReportContents,
  tallyOf,
} from '../../src/apps/clients/meeting-report.js';

/** A meeting report's period, with no database. #291. */

const TODAY = '2026-11-25';

describe('the period a new report is offered', () => {
  it('starts the day after the period of the report shared last', () => {
    expect(defaultPeriodOf('2026-11-14', '2026-01-05', TODAY)).toEqual({
      from: '2026-11-15',
      to: TODAY,
    });
  });

  it('starts across a month and a year end', () => {
    expect(defaultPeriodOf('2026-10-31', '2026-01-05', TODAY).from).toBe('2026-11-01');
    expect(defaultPeriodOf('2025-12-31', '2025-01-05', TODAY).from).toBe('2026-01-01');
  });

  it('starts the day the role began, with none shared', () => {
    expect(defaultPeriodOf(null, '2026-09-01', TODAY)).toEqual({ from: '2026-09-01', to: TODAY });
  });

  it('is today alone where the last one shared ran to today', () => {
    expect(defaultPeriodOf(TODAY, '2026-09-01', TODAY)).toEqual({ from: TODAY, to: TODAY });
  });
});

describe('a period asked for', () => {
  const offered = { from: '2026-11-15', to: TODAY };

  /** The field and sentence a request was refused with. */
  function refusal(body: unknown): { field: string; message: string } | undefined {
    try {
      readPeriod(body, offered, TODAY);
      return undefined;
    } catch (error) {
      if (!(error instanceof InvalidMeetingReport)) throw error;
      return { field: error.field, message: error.message };
    }
  }

  it('is the one offered where a day is left out', () => {
    expect(readPeriod(undefined, offered, TODAY)).toEqual(offered);
    expect(readPeriod({}, offered, TODAY)).toEqual(offered);
    expect(readPeriod({ from: null, to: '' }, offered, TODAY)).toEqual(offered);
    expect(readPeriod({ from: '2026-11-01' }, offered, TODAY)).toEqual({
      from: '2026-11-01',
      to: TODAY,
    });
    expect(readPeriod({ to: '2026-11-20' }, offered, TODAY)).toEqual({
      from: '2026-11-15',
      to: '2026-11-20',
    });
  });

  it('may cover a single day', () => {
    expect(readPeriod({ from: TODAY, to: TODAY }, offered, TODAY)).toEqual({
      from: TODAY,
      to: TODAY,
    });
  });

  it('is given as dates', () => {
    expect(refusal({ from: '15/11/2026' })?.field).toBe('from');
    expect(refusal({ to: '2026-02-30' })?.field).toBe('to');
    expect(refusal({ from: 20261115 })?.field).toBe('from');
  });

  it('ends today at the latest', () => {
    expect(refusal({ to: '2026-11-26' })).toEqual({
      field: 'to',
      message: 'That day has not come yet. End it today or earlier.',
    });
  });

  it('starts on or before the day it ends', () => {
    expect(refusal({ from: '2026-11-21', to: '2026-11-20' })).toEqual({
      field: 'from',
      message: 'Start it on or before the day it ends.',
    });
  });
});

describe('the counts on top of a report', () => {
  const client = { id: '1', name: 'Ecobank' };
  const nothing: ReportContents = {
    activities: [],
    stageMoves: [],
    stepsDone: [],
    stepsOverdue: [],
    pocs: [],
  };

  it('names every kind of activity and every health, a zero included', () => {
    const tally = tallyOf(nothing);

    expect(tally.activities.map((one) => one.kind)).toEqual([
      'CALL',
      'MEETING',
      'DEMO',
      'PROPOSAL',
      'FINANCIALS',
      'REVIEW',
      'NOTE',
    ]);
    expect(tally.activities.every((one) => one.count === 0)).toBe(true);
    expect(tally).toMatchObject({
      activitiesTotal: 0,
      stageMoves: 0,
      stepsDone: 0,
      stepsOverdue: 0,
      pocs: { ON_TRACK: 0, AT_RISK: 0, STALLED: 0 },
      pocsTotal: 0,
    });
  });

  it('counts each list, and the POCs by their health at the end', () => {
    const activity = (id: string, kind: 'CALL' | 'DEMO') => ({
      id,
      happenedOn: '2026-10-01',
      kind,
      client,
      deal: null,
      withWhom: null,
      outcome: null,
    });
    const step = (id: string) => ({
      id,
      description: 'Call back',
      client,
      deal: null,
      dueOn: '2026-10-01',
      doneOn: null,
    });
    const poc = (id: string, healthAtEnd: 'ON_TRACK' | 'STALLED') => ({
      id,
      client,
      line: 'Symphony',
      startedOn: '2026-09-01',
      decisionOn: '2026-11-10',
      healthAtEnd,
      changes: [],
      ended: null,
    });

    const tally = tallyOf({
      activities: [activity('1', 'CALL'), activity('2', 'CALL'), activity('3', 'DEMO')],
      stageMoves: [],
      stepsDone: [step('4')],
      stepsOverdue: [step('5'), step('6')],
      pocs: [poc('7', 'STALLED'), poc('8', 'STALLED'), poc('9', 'ON_TRACK')],
    });

    expect(tally.activities.find((one) => one.kind === 'CALL')?.count).toBe(2);
    expect(tally.activities.find((one) => one.kind === 'DEMO')?.count).toBe(1);
    expect(tally).toMatchObject({
      activitiesTotal: 3,
      stepsDone: 1,
      stepsOverdue: 2,
      pocs: { ON_TRACK: 1, AT_RISK: 0, STALLED: 2 },
      pocsTotal: 3,
    });
  });
});

describe('the written sections', () => {
  const current = freshSections();

  /** The field and sentence a request was refused with. */
  function refusal(body: unknown): { field: string; message: string } | undefined {
    try {
      readSections(body, current);
      return undefined;
    } catch (error) {
      if (!(error instanceof InvalidMeetingReport)) throw error;
      return { field: error.field, message: error.message };
    }
  }

  /* The user, 25 November 2026: four placeholders until the team confirms. */
  it('start as the four placeholders, each empty', () => {
    expect(current).toEqual([
      { key: 'PROGRESS', heading: 'Progress and wins', body: null },
      { key: 'BLOCKERS', heading: 'Blockers and where I need help', body: null },
      { key: 'NEXT_PERIOD', heading: 'Plan for the next period', body: null },
      { key: 'OTHER', heading: 'Anything else', body: null },
    ]);
  });

  it('take new words for those named, trimmed, and keep the rest', () => {
    const written = readSections({ sections: { PROGRESS: '  Signed ADB.  ' } }, current);
    expect(written[0].body).toBe('Signed ADB.');
    expect(written.slice(1)).toEqual(current.slice(1));

    const again = readSections({ sections: { BLOCKERS: 'Waiting on legal.' } }, written);
    expect(again.map((section) => section.body)).toEqual([
      'Signed ADB.',
      'Waiting on legal.',
      null,
      null,
    ]);
  });

  it('are emptied by blank words or null', () => {
    const written = readSections({ sections: { PROGRESS: 'Signed ADB.' } }, current);

    expect(readSections({ sections: { PROGRESS: '   ' } }, written)[0].body).toBeNull();
    expect(readSections({ sections: { PROGRESS: null } }, written)[0].body).toBeNull();
  });

  it('are only the report’s own, given as text, and not too long', () => {
    expect(refusal({})?.field).toBe('sections');
    expect(refusal({ sections: ['x'] })?.field).toBe('sections');
    expect(refusal({ sections: { RISKS: 'x' } })).toEqual({
      field: 'sections.RISKS',
      message: 'This report has no such section.',
    });
    expect(refusal({ sections: { PROGRESS: 7 } })?.field).toBe('sections.PROGRESS');
    expect(refusal({ sections: { OTHER: 'x'.repeat(4001) } })).toEqual({
      field: 'sections.OTHER',
      message: 'Keep Anything else to 4000 characters.',
    });
    expect(readSections({ sections: { OTHER: 'x'.repeat(4000) } }, current)[3].body).toHaveLength(
      4000,
    );
  });

  it('keep the headings the report was started with, whatever the list says now', () => {
    const older = [{ key: 'NOTES', heading: 'Notes', body: null }];

    expect(readSections({ sections: { NOTES: 'Kept.' } }, older)).toEqual([
      { key: 'NOTES', heading: 'Notes', body: 'Kept.' },
    ]);
    expect(() => readSections({ sections: { PROGRESS: 'x' } }, older)).toThrow(
      InvalidMeetingReport,
    );
  });
});
