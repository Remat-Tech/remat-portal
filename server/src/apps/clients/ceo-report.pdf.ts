/**
 * A CEO report as a PDF. #292.
 *
 * The meeting report's "dashboard" design (#291, the user, 25 November 2026), one level up: the
 * team's numbers down the navy sidebar; then the pipeline as it stood, with the deals by stage as
 * bars beside the POCs' health; the team table, a row per associate and a total; what the BD
 * manager wrote; and what each associate wrote in the reports they shared, never cut, so it may
 * run onto more pages. A draft says so at the top.
 *
 * In two halves, as the meeting report's: {@link ceoReportSheet} says what goes on the page, which
 * a test can read, and {@link renderCeoPdf} draws it.
 */

import { calendarDateIn, formatInstant } from '../../core/calendar/time.js';
import { type CeoReportView, moneyInWords } from './ceo-report.js';
import type { PocHealth } from './poc.js';
import {
  C,
  capped,
  cell,
  drawBars,
  drawHeader,
  drawHealthBar,
  drawSidebar,
  drawWritten,
  HEALTH_COLOUR,
  HEALTH_NAME,
  heading,
  mainColumn,
  more,
  newPage,
  none,
  PAGE,
  periodInWords,
  renderReportPdf,
  shortDay,
  slugOf,
  table,
} from './report-pdf.js';
import { STAGE_NAME } from './stage.js';

/** The most associates the team table shows before "+N more in the portal". */
export const CEO_PDF_ROWS = { team: 12 } as const;

export interface CeoSheet {
  title: string;
  period: string;
  byline: string;
  status: { text: string; tone: 'DRAFT' | 'SUBMITTED' | 'DISCARDED' };
  counts: { label: string; value: number; warn: boolean }[];
  pipeline: {
    /** "GHS 1,250,000.00", one a currency; empty where nothing is recorded. */
    recorded: string[];
    /** "24 open deals · 15 clients". */
    deals: string;
    noValue: number;
    /** Every open stage, in ladder order. */
    stages: { name: string; count: number }[];
    health: Record<PocHealth, number>;
    pocsTotal: number;
  };
  team: { rows: TeamLine[]; more: number; total: TeamLine | null };
  /** What the BD manager wrote. */
  own: { heading: string; body: string | null }[];
  /** What each associate wrote, under their name: "Ama Mensah · Progress and wins". */
  words: { heading: string; body: string | null }[];
  footer: string;
}

export interface TeamLine {
  name: string;
  reports: number;
  activities: number;
  stageMoves: number;
  stepsDone: number;
  stepsOverdue: number;
  pocs: number;
}

/** What a CEO report's PDF shows. `zone` is the one moments are read in. */
export function ceoReportSheet(report: CeoReportView, zone: string): CeoSheet {
  const period = periodInWords(report.period.from, report.period.to);
  const { totals, pipeline } = report;

  const status: CeoSheet['status'] =
    report.status === 'DRAFT'
      ? { text: 'DRAFT · NOT YET SUBMITTED', tone: 'DRAFT' }
      : report.status === 'DISCARDED'
        ? { text: 'DISCARDED', tone: 'DISCARDED' }
        : {
            text: `SUBMITTED ${shortDay(calendarDateIn(report.submittedAt ?? report.createdAt, zone))}`,
            tone: 'SUBMITTED',
          };

  const lines: TeamLine[] = report.team.map((row) => ({
    name: row.author.name,
    reports: row.reports,
    activities: row.activities,
    stageMoves: row.stageMoves,
    stepsDone: row.stepsDone,
    stepsOverdue: row.stepsOverdue,
    pocs: row.pocs,
  }));

  return {
    title: `Report to the CEO, ${report.author.name}, ${period}`,
    period,
    byline: `${report.author.name} · Figures as of ${formatInstant(report.figuresAt, zone)}`,
    status,
    counts: [
      { label: 'Reports shared', value: totals.reports, warn: false },
      { label: 'Activities', value: totals.activities, warn: false },
      { label: 'Stage changes', value: totals.stageMoves, warn: false },
      { label: 'Steps overdue', value: totals.stepsOverdue, warn: totals.stepsOverdue > 0 },
      { label: 'POCs running', value: pipeline.pocsTotal, warn: false },
    ],
    pipeline: {
      recorded: pipeline.recorded.map(moneyInWords),
      deals:
        `${plural(pipeline.opportunities, 'open deal')} · ` + plural(pipeline.clients, 'client'),
      noValue: pipeline.noValue,
      stages: pipeline.stages.map((stage) => ({
        name: STAGE_NAME[stage.stage],
        count: stage.opportunities,
      })),
      health: pipeline.pocs,
      pocsTotal: pipeline.pocsTotal,
    },
    team: {
      ...capped(lines, CEO_PDF_ROWS.team),
      total: lines.length === 0 ? null : { name: 'Team', ...totals },
    },
    own: report.sections.map(({ heading, body }) => ({ heading, body })),
    words: report.words.flatMap((shared) => {
      const written = shared.sections.filter((section) => section.body !== null);
      const whose = `${shared.author.name} · ${periodInWords(shared.period.from, shared.period.to)}`;

      return written.length === 0
        ? [{ heading: whose, body: null }]
        : written.map((section) => ({
            heading: `${shared.author.name} · ${section.heading}`,
            body: section.body,
          }));
    }),
    footer: `Rota · Clients · Report to the CEO · ${report.author.name} · ${period}`,
  };
}

/** "report-to-the-ceo-esi-boateng-2026-11-01-to-2026-11-27.pdf". */
export function ceoPdfName(report: CeoReportView): string {
  return (
    `report-to-the-ceo-${slugOf(report.author.name) || 'report'}-` +
    `${report.period.from}-to-${report.period.to}.pdf`
  );
}

/** Draws the sheet on A4, the sidebar on the first page and a footer on every one. */
export function renderCeoPdf(sheet: CeoSheet): Promise<Buffer> {
  return renderReportPdf({ title: sheet.title, footer: sheet.footer }, (doc) => {
    drawHeader(doc, {
      label: 'Rota · Clients · Report to the CEO',
      title: sheet.period,
      byline: sheet.byline,
      status: {
        text: sheet.status.text,
        tone: sheet.status.tone === 'SUBMITTED' ? 'DONE' : sheet.status.tone,
      },
    });
    drawSidebar(doc, sheet.counts);

    const { x: X, width: MW } = mainColumn(doc);
    const half = (MW - PAGE.gutter) / 2;
    let y = heading(doc, 'The pipeline as it stands', X, PAGE.top);

    /* the value recorded, then the deals and clients */
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.blue);
    if (sheet.pipeline.recorded.length === 0) {
      doc.text('No value recorded', X, y, { width: MW, height: 20, ellipsis: true });
      y += 20;
    } else {
      for (const line of sheet.pipeline.recorded) {
        doc.text(line, X, y, { width: MW, height: 20, ellipsis: true });
        y += 20;
      }
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(C.soft);
    doc.text(
      `Recorded value · ${sheet.pipeline.deals}` +
        (sheet.pipeline.noValue === 0
          ? ''
          : ` · ${plural(sheet.pipeline.noValue, 'deal')} with no value`),
      X,
      y,
      { width: MW, height: 11, ellipsis: true },
    );
    y += 22;

    /* deals by stage, beside the POCs' health */
    const left = drawBars(
      doc,
      sheet.pipeline.stages,
      X,
      heading(doc, 'Open deals by stage', X, y),
      half,
      'No open deals.',
    );

    const PX = X + half + PAGE.gutter;
    let right = heading(doc, 'POC health', PX, y);
    if (sheet.pipeline.pocsTotal === 0) {
      right = none(doc, 'No POCs running.', PX, right);
    } else {
      right = drawHealthBar(doc, sheet.pipeline.health, PX, right, half);
      for (const health of ['ON_TRACK', 'AT_RISK', 'STALLED'] as const) {
        doc.circle(PX + 4, right + 4, 3.2).fill(HEALTH_COLOUR[health]);
        doc.font('Helvetica').fontSize(8.5).fillColor(C.ink);
        doc.text(HEALTH_NAME[health], PX + 12, right, {
          width: half - 40,
          height: 10,
          ellipsis: true,
        });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
        doc.text(String(sheet.pipeline.health[health]), PX + half - 28, right, {
          width: 28,
          align: 'right',
          lineBreak: false,
        });
        right += 15;
      }
    }

    y = Math.max(left, right) + 16;

    /* the team */
    y = heading(doc, 'The team', X, y);
    if (sheet.team.rows.length === 0) {
      y = none(doc, 'No meeting reports were shared in this period.', X, y);
    } else {
      const number = (value: (row: TeamLine) => number, label: string, width = 46) => ({
        label,
        width,
        align: 'right' as const,
        draw: cell<TeamLine>((row) => String(value(row)), false, C.ink, 'right'),
      });
      y = table<TeamLine>(
        doc,
        X,
        y,
        sheet.team.rows,
        [
          {
            label: 'Associate',
            width: MW - 52 - 60 - 44 - 40 - 56 - 40,
            draw: cell((row) => row.name, true),
          },
          number((row) => row.reports, 'Reports', 52),
          number((row) => row.activities, 'Activities', 60),
          number((row) => row.stageMoves, 'Moves', 44),
          number((row) => row.stepsDone, 'Done', 40),
          {
            label: 'Overdue',
            width: 56,
            align: 'right',
            draw: (d, row, x, yy, w) => {
              d.font('Helvetica-Bold')
                .fontSize(8.5)
                .fillColor(row.stepsOverdue > 0 ? C.red : C.ink);
              d.text(String(row.stepsOverdue), x, yy + 5, {
                width: w,
                align: 'right',
                lineBreak: false,
              });
            },
          },
          number((row) => row.pocs, 'POCs', 40),
        ],
        sheet.team.total ?? undefined,
      );
      y = more(doc, sheet.team.more, X, y);
    }

    /* the BD manager's words, then the associates' */
    y = heading(doc, 'From the BD manager', X, y + 14);
    let at = drawWritten(doc, sheet.own, X, y, MW);

    if (at.y + 40 > doc.page.height - PAGE.footer - 10) {
      at = newPage(doc);
    }
    y = heading(doc, "In the associates' words", at.x, at.y + 6);
    if (sheet.words.length === 0) {
      none(doc, 'No meeting reports were shared in this period.', at.x, y);
    } else {
      drawWritten(doc, sheet.words, at.x, y, at.width);
    }
  });
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
