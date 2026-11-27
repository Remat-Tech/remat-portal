import { describe, expect, it } from 'vitest';
import {
  freshSections,
  type MeetingReportView,
  tallyOf,
} from '../../src/apps/clients/meeting-report.js';
import {
  PDF_ROWS,
  renderPdf,
  reportPdfName,
  reportSheet,
} from '../../src/apps/clients/meeting-report.pdf.js';

/** A meeting report as a PDF, with no database. #291. */

const client = { id: '1', name: 'Ecobank' };

function aReport(change: Partial<MeetingReportView> = {}): MeetingReportView {
  const contents = {
    activities: [
      {
        id: '1',
        happenedOn: '2026-11-03',
        kind: 'MEETING' as const,
        client,
        deal: { id: '9', product: 'CreditStudio' },
        withWhom: null,
        outcome: 'They want a demo.',
      },
    ],
    stageMoves: [
      {
        id: '2',
        movedOn: '2026-11-04',
        client,
        deal: { id: '9', product: 'CreditStudio' },
        from: 'DISCOVERY' as const,
        to: 'QUALIFICATION' as const,
        outcome: 'OPEN' as const,
        note: null,
        by: { id: '50', name: 'Esi Boateng' },
      },
    ],
    stepsDone: [],
    stepsOverdue: [
      {
        id: '3',
        description: 'Send the pricing',
        client,
        deal: null,
        dueOn: '2026-11-10',
        doneOn: null,
      },
    ],
    pocs: [],
  };

  return {
    id: '7',
    author: { id: '40', name: 'Ama Mensah' },
    period: { from: '2026-11-01', to: '2026-11-14' },
    status: 'DRAFT',
    createdAt: new Date('2026-11-14T09:00:00Z'),
    sharedAt: null,
    discardedAt: null,
    contents,
    tally: tallyOf(contents),
    sections: freshSections().map((section) =>
      section.key === 'PROGRESS' ? { ...section, body: 'Ecobank moved on.' } : section,
    ),
    figuresAt: new Date('2026-11-14T09:00:00Z'),
    may: { change: true },
    ...change,
  };
}

/** The deal that moved, repeated, to fill a list past its limit. */
function moves(n: number) {
  const one = aReport().contents.stageMoves[0];
  return Array.from({ length: n }, (_, index) => ({ ...one, id: String(index) }));
}

describe('a meeting report as a PDF', () => {
  /* The "dashboard" design the user chose on 25 November 2026. */
  it('shows the counts, the lists and the written sections, as the page does', () => {
    const sheet = reportSheet(aReport(), 'UTC');

    expect(sheet).toMatchObject({
      period: '1 – 14 November 2026',
      byline: 'Ama Mensah · Figures as of 14 November 2026, 09:00 UTC',
      status: { text: 'DRAFT · NOT YET SHARED', tone: 'DRAFT' },
      counts: [
        { label: 'Activities', value: 1, warn: false },
        { label: 'Stage changes', value: 1, warn: false },
        { label: 'Steps done', value: 0, warn: false },
        { label: 'Steps overdue', value: 1, warn: true },
        { label: 'POCs', value: 0, warn: false },
      ],
      kinds: [{ name: 'Meetings', count: 1 }],
      pocs: { health: { ON_TRACK: 0, AT_RISK: 0, STALLED: 0 }, rows: [], more: 0 },
      moves: {
        rows: [
          {
            client: 'Ecobank',
            product: 'CreditStudio',
            from: 'Discovery',
            to: 'Qualification',
            tone: 'PLAIN',
            day: '4 Nov',
          },
        ],
        more: 0,
      },
      overdue: { rows: [{ step: 'Send the pricing', client: 'Ecobank', due: '10 Nov', late: 4 }] },
      footer: 'Rota · Clients · Ama Mensah · 1 – 14 November 2026',
    });
    expect(sheet.sections).toEqual([
      { heading: 'Progress and wins', body: 'Ecobank moved on.' },
      { heading: 'Blockers and where I need help', body: null },
      { heading: 'Plan for the next period', body: null },
      { heading: 'Anything else', body: null },
    ]);
    /* No "Confidential" (the user, 25 November 2026). */
    expect(sheet.footer).not.toMatch(/confidential/i);
  });

  it('says whether it is a draft, shared or discarded', () => {
    expect(
      reportSheet(aReport({ status: 'SHARED', sharedAt: new Date('2026-11-14T10:00:00Z') }), 'UTC')
        .status,
    ).toEqual({ text: 'SHARED 14 Nov', tone: 'SHARED' });
    expect(
      reportSheet(
        aReport({ status: 'DISCARDED', discardedAt: new Date('2026-11-14T10:00:00Z') }),
        'UTC',
      ).status,
    ).toEqual({ text: 'DISCARDED', tone: 'DISCARDED' });
  });

  it('stops each list at a few rows, and says how many more are in the portal', () => {
    const long = aReport();
    long.contents.stageMoves = moves(PDF_ROWS.moves + 3);

    const sheet = reportSheet(long, 'UTC');
    expect(sheet.moves.rows).toHaveLength(PDF_ROWS.moves);
    expect(sheet.moves.more).toBe(3);
  });

  it('colours a move by where it went', () => {
    const report = aReport();
    const [one] = report.contents.stageMoves;
    report.contents.stageMoves = [
      { ...one, from: 'NEGOTIATION', to: 'CONTRACT_SIGNED' },
      { ...one, from: 'QUALIFICATION', to: 'QUALIFICATION', outcome: 'LOST' },
      { ...one, from: null, to: 'DISCOVERY' },
    ];

    expect(
      reportSheet(report, 'UTC').moves.rows.map((row) => [row.from, row.to, row.tone]),
    ).toEqual([
      ['Negotiation', 'Contract signed', 'GOOD'],
      ['Qualification', 'Lost', 'BAD'],
      ['new deal', 'Discovery', 'PLAIN'],
    ]);
  });

  it('names a period across months, and a single day', () => {
    expect(
      reportSheet(aReport({ period: { from: '2026-10-28', to: '2026-11-14' } }), 'UTC').period,
    ).toBe('28 October – 14 November 2026');
    expect(
      reportSheet(aReport({ period: { from: '2026-11-14', to: '2026-11-14' } }), 'UTC').period,
    ).toBe('14 November 2026');
  });

  it('is named for its author and period', () => {
    expect(reportPdfName(aReport())).toBe('meeting-report-ama-mensah-2026-11-01-to-2026-11-14.pdf');
    expect(reportPdfName(aReport({ author: { id: '1', name: "Kofi O'Brien-Asante" } }))).toBe(
      'meeting-report-kofi-o-brien-asante-2026-11-01-to-2026-11-14.pdf',
    );
  });

  it('draws as one page', async () => {
    const bytes = await renderPdf(reportSheet(aReport(), 'UTC'));

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pagesIn(bytes)).toBe(1);
  });

  /* The author's own words are never cut. */
  it('runs long written sections onto another page', async () => {
    const long = aReport();
    long.sections = long.sections.map((section) => ({ ...section, body: 'Words. '.repeat(500) }));

    expect(pagesIn(await renderPdf(reportSheet(long, 'UTC')))).toBeGreaterThan(1);
  });
});

function pagesIn(bytes: Buffer): number {
  return (bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
}
