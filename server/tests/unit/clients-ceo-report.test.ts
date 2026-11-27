import { describe, expect, it } from 'vitest';
import {
  type CeoReportView,
  defaultCeoPeriodOf,
  freshCeoSections,
  moneyInWords,
  type SharedReport,
  teamOf,
} from '../../src/apps/clients/ceo-report.js';
import {
  CEO_PDF_ROWS,
  ceoPdfName,
  ceoReportSheet,
  renderCeoPdf,
} from '../../src/apps/clients/ceo-report.pdf.js';
import { freshSections, tallyOf } from '../../src/apps/clients/meeting-report.js';

/** The report to the CEO, with no database. #292. */

const TODAY = '2026-11-27';

describe('the period a new CEO report is offered', () => {
  it('starts the day after the one submitted last', () => {
    expect(defaultCeoPeriodOf('2026-11-10', TODAY)).toEqual({ from: '2026-11-11', to: TODAY });
  });

  it('starts the 1st of the month, for a first one', () => {
    expect(defaultCeoPeriodOf(null, TODAY)).toEqual({ from: '2026-11-01', to: TODAY });
    expect(defaultCeoPeriodOf(null, '2026-11-01')).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
    });
  });

  it('is today alone where the last one ran to today', () => {
    expect(defaultCeoPeriodOf(TODAY, TODAY)).toEqual({ from: TODAY, to: TODAY });
  });
});

/** A meeting report shared, with so many calls and steps overdue, and words in its first section. */
function aShared(
  id: string,
  author: [string, string],
  sharedAt: string,
  calls: number,
  overdue: number,
  words: string | null = null,
): SharedReport {
  const contents = {
    activities: Array.from({ length: calls }, (_, index) => ({
      id: String(index),
      happenedOn: '2026-11-03',
      kind: 'CALL' as const,
      client: { id: '1', name: 'Ecobank' },
      deal: null,
      withWhom: null,
      outcome: null,
    })),
    stageMoves: [],
    stepsDone: [],
    stepsOverdue: Array.from({ length: overdue }, (_, index) => ({
      id: String(index),
      description: 'Send the pricing',
      client: { id: '1', name: 'Ecobank' },
      deal: null,
      dueOn: '2026-11-03',
      doneOn: null,
    })),
    pocs: [],
  };

  return {
    id,
    author: { id: author[0], name: author[1] },
    period: { from: '2026-11-01', to: '2026-11-14' },
    sharedAt: new Date(sharedAt),
    tally: tallyOf(contents),
    sections: freshSections().map((section, index) =>
      index === 0 ? { ...section, body: words } : section,
    ),
  };
}

const AMA: [string, string] = ['1', 'Ama Mensah'];
const KOFI: [string, string] = ['2', 'Kofi Asante'];

describe('the team table', () => {
  it('is a row per associate, A to Z, and a total; the words in the order they were shared', () => {
    const figures = teamOf([
      aShared('10', KOFI, '2026-11-12T09:00:00Z', 4, 2),
      aShared('11', AMA, '2026-11-05T09:00:00Z', 3, 1, 'Signed Ecobank.'),
      aShared('12', AMA, '2026-11-20T09:00:00Z', 2, 0),
    ]);

    expect(
      figures.team.map((row) => [row.author.name, row.reports, row.activities, row.stepsOverdue]),
    ).toEqual([
      ['Ama Mensah', 2, 5, 1],
      ['Kofi Asante', 1, 4, 2],
    ]);
    expect(figures.totals).toEqual({
      reports: 3,
      activities: 9,
      stageMoves: 0,
      stepsDone: 0,
      stepsOverdue: 3,
      pocs: 0,
    });
    expect(figures.words.map((one) => one.reportId)).toEqual(['11', '10', '12']);
    expect(figures.words[0].sharedAt).toBe('2026-11-05T09:00:00.000Z');
    expect(figures.words[0].sections[0]).toMatchObject({
      heading: 'Progress and wins',
      body: 'Signed Ecobank.',
    });
  });

  it('is empty with nothing shared', () => {
    expect(teamOf([])).toEqual({
      team: [],
      totals: { reports: 0, activities: 0, stageMoves: 0, stepsDone: 0, stepsOverdue: 0, pocs: 0 },
      words: [],
    });
  });
});

describe('money in words', () => {
  it('is minor units in its own currency, two places', () => {
    expect(moneyInWords({ amountMinor: 125_000_000, currency: 'GHS' })).toBe('GHS 1,250,000.00');
    expect(moneyInWords({ amountMinor: 5, currency: 'USD' })).toBe('USD 0.05');
  });
});

function aReport(change: Partial<CeoReportView> = {}): CeoReportView {
  const figures = teamOf([
    aShared('10', KOFI, '2026-11-12T09:00:00Z', 4, 2),
    aShared('11', AMA, '2026-11-05T09:00:00Z', 3, 1, 'Signed Ecobank.'),
  ]);

  return {
    id: '7',
    author: { id: '3', name: 'Esi Boateng' },
    period: { from: '2026-11-01', to: TODAY },
    status: 'DRAFT',
    createdAt: new Date('2026-11-27T09:00:00Z'),
    submittedAt: null,
    submittedTo: null,
    discardedAt: null,
    ...figures,
    pipeline: {
      recorded: [{ amountMinor: 125_000_000, currency: 'GHS' }],
      opportunities: 12,
      clients: 9,
      noValue: 3,
      stages: [
        { stage: 'DISCOVERY', opportunities: 5, recorded: [], noValue: 2 },
        { stage: 'POC', opportunities: 2, recorded: [], noValue: 0 },
      ],
      pocs: { ON_TRACK: 1, AT_RISK: 1, STALLED: 0 },
      pocsTotal: 2,
    },
    sections: freshCeoSections().map((section) =>
      section.key === 'HIGHLIGHTS' ? { ...section, body: 'Fidelity signed.' } : section,
    ),
    figuresAt: new Date('2026-11-27T09:00:00Z'),
    may: { change: true },
    ...change,
  };
}

describe('a CEO report as a PDF', () => {
  it('shows the team, the pipeline and the words, as the page does', () => {
    const sheet = ceoReportSheet(aReport(), 'UTC');

    expect(sheet).toMatchObject({
      period: '1 – 27 November 2026',
      byline: 'Esi Boateng · Figures as of 27 November 2026, 09:00 UTC',
      status: { text: 'DRAFT · NOT YET SUBMITTED', tone: 'DRAFT' },
      counts: [
        { label: 'Reports shared', value: 2, warn: false },
        { label: 'Activities', value: 7, warn: false },
        { label: 'Stage changes', value: 0, warn: false },
        { label: 'Steps overdue', value: 3, warn: true },
        { label: 'POCs running', value: 2, warn: false },
      ],
      pipeline: {
        recorded: ['GHS 1,250,000.00'],
        deals: '12 open deals · 9 clients',
        noValue: 3,
        stages: [
          { name: 'Discovery', count: 5 },
          { name: 'POC', count: 2 },
        ],
      },
      team: {
        rows: [{ name: 'Ama Mensah' }, { name: 'Kofi Asante' }],
        more: 0,
        total: { name: 'Team', reports: 2, activities: 7 },
      },
      footer: 'Rota · Clients · Report to the CEO · Esi Boateng · 1 – 27 November 2026',
    });
    expect(sheet.own[0]).toEqual({ heading: 'Highlights', body: 'Fidelity signed.' });
    /* What each associate wrote, under their name; one who wrote nothing says so once. */
    expect(sheet.words).toEqual([
      { heading: 'Ama Mensah · Progress and wins', body: 'Signed Ecobank.' },
      { heading: 'Kofi Asante · 1 – 14 November 2026', body: null },
    ]);
    expect(sheet.footer).not.toMatch(/confidential/i);
  });

  it('says whether it is a draft, submitted or discarded', () => {
    expect(
      ceoReportSheet(
        aReport({ status: 'SUBMITTED', submittedAt: new Date('2026-11-27T15:00:00Z') }),
        'UTC',
      ).status,
    ).toEqual({ text: 'SUBMITTED 27 Nov', tone: 'SUBMITTED' });
    expect(
      ceoReportSheet(aReport({ status: 'DISCARDED', discardedAt: new Date() }), 'UTC').status,
    ).toEqual({ text: 'DISCARDED', tone: 'DISCARDED' });
  });

  it('stops the team table at a dozen associates', () => {
    const many = aReport();
    many.team = Array.from({ length: CEO_PDF_ROWS.team + 2 }, (_, index) => ({
      ...many.team[0],
      author: { id: String(index), name: `Associate ${String(index)}` },
    }));

    expect(ceoReportSheet(many, 'UTC').team).toMatchObject({ more: 2 });
  });

  it('is named for its author and period', () => {
    expect(ceoPdfName(aReport())).toBe(
      'report-to-the-ceo-esi-boateng-2026-11-01-to-2026-11-27.pdf',
    );
  });

  it('draws as a PDF, running long words onto more pages', async () => {
    const short = await renderCeoPdf(ceoReportSheet(aReport(), 'UTC'));
    expect(short.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pagesIn(short)).toBe(1);

    const long = aReport();
    long.sections = long.sections.map((section) => ({ ...section, body: 'Words. '.repeat(400) }));
    expect(pagesIn(await renderCeoPdf(ceoReportSheet(long, 'UTC')))).toBeGreaterThan(1);
  });
});

function pagesIn(bytes: Buffer): number {
  return (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
}
