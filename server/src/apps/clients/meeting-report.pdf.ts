/**
 * A meeting report as a PDF, to print, attach or put on a screen in the meeting. #291.
 *
 * The "dashboard" design the user chose on 25 November 2026, from two samples: a white header with
 * the Rota icon and a blue rule, the five counts down a navy sidebar, then activities by kind as
 * bars beside the POCs' health, the deals that moved, the steps overdue, and what the author wrote.
 * One page as a rule: each list stops at a few rows and says how many more are in the portal. Only
 * the written sections, which are the author's own words and never cut, may run onto a second.
 *
 * Whoever may open a report may download it, a draft included, which says so at the top. No
 * "Confidential" in the footer (the user, 25 November 2026). Drawn in pdfkit's built-in Helvetica:
 * the portal's own web fonts cannot be embedded.
 *
 * In two halves: {@link reportSheet} says what goes on the page, which a test can read, and
 * {@link renderPdf} draws it, with what every clients PDF shares (report-pdf.ts).
 */

import { calendarDateIn, formatInstant } from '../../core/calendar/time.js';
import { ACTIVITY_KINDS, type ActivityKind } from './logged-activity.js';
import type { MeetingReportView } from './meeting-report.js';
import { POC_HEALTHS, type PocHealth } from './poc.js';
import {
  C,
  capped,
  cell,
  daysBetween,
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
  none,
  PAGE,
  periodInWords,
  renderReportPdf,
  shortDay,
  slugOf,
  table,
} from './report-pdf.js';
import { STAGE_NAME } from './stage.js';

export { HEALTH_NAME };

/** The most rows each list shows before "+N more in the portal". */
export const PDF_ROWS = { moves: 6, overdue: 5, pocs: 6 } as const;

/** Everything the page shows, worked out, in the order it is drawn. */
export interface ReportSheet {
  title: string;
  /** "1 – 14 November 2026". */
  period: string;
  /** "Ama Mensah · Figures as of 14 November 2026, 09:00 GMT". */
  byline: string;
  status: { text: string; tone: 'DRAFT' | 'SHARED' | 'DISCARDED' };
  counts: { label: string; value: number; warn: boolean }[];
  /** Only the kinds there were, most first. */
  kinds: { name: string; count: number }[];
  pocs: { health: Record<PocHealth, number>; rows: SheetPoc[]; more: number };
  moves: { rows: SheetMove[]; more: number };
  overdue: { rows: SheetOverdue[]; more: number };
  sections: { heading: string; body: string | null }[];
  footer: string;
}

export interface SheetPoc {
  client: string;
  health: PocHealth;
  /** "Symphony · decision 10 Dec", or "Symphony · converted 3 Nov". */
  note: string;
}

export interface SheetMove {
  client: string;
  product: string;
  from: string;
  to: string;
  /** Green for signed or live, red for lost or exited. */
  tone: 'GOOD' | 'BAD' | 'PLAIN';
  day: string;
}

export interface SheetOverdue {
  step: string;
  client: string;
  due: string;
  /** Whole days late at the period's end. */
  late: number;
}

const KIND_NAME: Record<ActivityKind, string> = {
  CALL: 'Calls',
  MEETING: 'Meetings',
  DEMO: 'Demos',
  PROPOSAL: 'Proposals sent',
  FINANCIALS: 'Financials sent',
  REVIEW: 'Review meetings',
  NOTE: 'Notes',
};

/** What a report's PDF shows. `zone` is the one moments are read in. */
export function reportSheet(report: MeetingReportView, zone: string): ReportSheet {
  const { contents, tally } = report;
  const period = periodInWords(report.period.from, report.period.to);

  const status: ReportSheet['status'] =
    report.status === 'DRAFT'
      ? { text: 'DRAFT · NOT YET SHARED', tone: 'DRAFT' }
      : report.status === 'DISCARDED'
        ? { text: 'DISCARDED', tone: 'DISCARDED' }
        : {
            text: `SHARED ${shortDay(calendarDateIn(report.sharedAt ?? report.createdAt, zone))}`,
            tone: 'SHARED',
          };

  const health = Object.fromEntries(POC_HEALTHS.map((one) => [one, tally.pocs[one]])) as Record<
    PocHealth,
    number
  >;

  return {
    title: `Meeting report, ${report.author.name}, ${period}`,
    period,
    byline: `${report.author.name} · Figures as of ${formatInstant(report.figuresAt, zone)}`,
    status,
    counts: [
      { label: 'Activities', value: tally.activitiesTotal, warn: false },
      { label: 'Stage changes', value: tally.stageMoves, warn: false },
      { label: 'Steps done', value: tally.stepsDone, warn: false },
      { label: 'Steps overdue', value: tally.stepsOverdue, warn: tally.stepsOverdue > 0 },
      { label: 'POCs', value: tally.pocsTotal, warn: false },
    ],
    kinds: ACTIVITY_KINDS.map((kind) => ({
      name: KIND_NAME[kind],
      count: tally.activities.find((one) => one.kind === kind)?.count ?? 0,
    }))
      .filter((one) => one.count > 0)
      .sort((one, other) => other.count - one.count),
    pocs: {
      health,
      ...capped(
        contents.pocs.map((poc) => ({
          client: poc.client.name,
          health: poc.healthAtEnd,
          note:
            `${poc.line} · ` +
            (poc.ended === null
              ? `decision ${shortDay(poc.decisionOn)}`
              : `${poc.ended.outcome === 'WON' ? 'converted' : 'exited'} ${shortDay(poc.ended.on)}`),
        })),
        PDF_ROWS.pocs,
      ),
    },
    moves: capped(
      contents.stageMoves.map((move): SheetMove => {
        const ended = move.outcome === 'LOST' || move.outcome === 'EXITED';
        return {
          client: move.client.name,
          product: move.deal.product,
          from: move.from === null ? 'new deal' : STAGE_NAME[move.from],
          to:
            move.outcome === 'LOST'
              ? 'Lost'
              : move.outcome === 'EXITED'
                ? 'Exited'
                : STAGE_NAME[move.to],
          tone: ended
            ? 'BAD'
            : move.to === 'CONTRACT_SIGNED' || move.to === 'LIVE'
              ? 'GOOD'
              : 'PLAIN',
          day: shortDay(move.movedOn),
        };
      }),
      PDF_ROWS.moves,
    ),
    overdue: capped(
      contents.stepsOverdue.map((step) => ({
        step: step.description,
        client: step.client.name,
        due: shortDay(step.dueOn),
        late: daysBetween(step.dueOn, report.period.to),
      })),
      PDF_ROWS.overdue,
    ),
    sections: report.sections.map(({ heading, body }) => ({ heading, body })),
    footer: `Rota · Clients · ${report.author.name} · ${period}`,
  };
}

/** "meeting-report-ama-mensah-2026-11-01-to-2026-11-14.pdf". */
export function reportPdfName(report: MeetingReportView): string {
  return `meeting-report-${slugOf(report.author.name) || 'report'}-${report.period.from}-to-${report.period.to}.pdf`;
}

/* ------------------------------------------------------------------------------ drawing */

/** Draws the sheet on A4, the sidebar on the first page and a footer on every one. */
export function renderPdf(sheet: ReportSheet): Promise<Buffer> {
  return renderReportPdf({ title: sheet.title, footer: sheet.footer }, (doc) => {
    drawHeader(doc, {
      label: 'Rota · Clients · Meeting report',
      title: sheet.period,
      byline: sheet.byline,
      status: {
        text: sheet.status.text,
        tone: sheet.status.tone === 'SHARED' ? 'DONE' : sheet.status.tone,
      },
    });
    drawSidebar(doc, sheet.counts);

    const { x: X, width: MW } = mainColumn(doc);
    const half = (MW - PAGE.gutter) / 2;
    const top = PAGE.top;

    /* activities by kind, beside the POCs */
    const left = drawBars(
      doc,
      sheet.kinds,
      X,
      heading(doc, 'Activities by kind', X, top),
      half,
      'No activities in this period.',
    );

    const PX = X + half + PAGE.gutter;
    let right = heading(doc, 'POC health', PX, top);
    if (sheet.pocs.rows.length === 0) {
      right = none(doc, 'No POCs in this period.', PX, right);
    } else {
      right = drawHealthBar(doc, sheet.pocs.health, PX, right, half);
      for (const poc of sheet.pocs.rows) {
        doc.circle(PX + 4, right + 4, 3.2).fill(HEALTH_COLOUR[poc.health]);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
        doc.text(poc.client, PX + 12, right, {
          width: half * 0.6 - 14,
          height: 10,
          ellipsis: true,
        });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(HEALTH_COLOUR[poc.health]);
        doc.text(HEALTH_NAME[poc.health], PX + half * 0.6, right + 0.5, {
          width: half * 0.4,
          align: 'right',
          height: 10,
          ellipsis: true,
        });
        doc.font('Helvetica').fontSize(7.5).fillColor(C.soft);
        doc.text(poc.note, PX + 12, right + 11, { width: half - 12, height: 10, ellipsis: true });
        right += 26;
      }
      right = more(doc, sheet.pocs.more, PX, right);
    }

    let y = Math.max(left, right) + 16;

    /* deals that moved */
    y = heading(doc, 'Deals that moved', X, y);
    if (sheet.moves.rows.length === 0) {
      y = none(doc, 'No stage changes in this period.', X, y);
    } else {
      y = table<SheetMove>(doc, X, y, sheet.moves.rows, [
        { label: 'Client', width: 96, draw: cell((row) => row.client, true) },
        { label: 'Product', width: 80, draw: cell((row) => row.product, false, C.soft) },
        { label: 'From', width: 74, draw: cell((row) => row.from, false, C.faint) },
        {
          label: 'To',
          width: MW - 96 - 80 - 74 - 40,
          draw: (d, row, x, yy, w) => {
            const colour = row.tone === 'GOOD' ? C.green : row.tone === 'BAD' ? C.red : C.ink;
            d.font('Helvetica-Bold').fontSize(8.5).fillColor(colour);
            d.text(row.to, x, yy + 5, { width: w, height: 10, ellipsis: true });
          },
        },
        {
          label: 'Day',
          width: 40,
          align: 'right',
          draw: cell((row) => row.day, false, C.soft, 'right'),
        },
      ]);
      y = more(doc, sheet.moves.more, X, y);
    }

    /* overdue */
    y = heading(doc, 'Overdue at the end', X, y + 14);
    if (sheet.overdue.rows.length === 0) {
      y = none(doc, 'Nothing overdue at the end of the period.', X, y);
    } else {
      y = table<SheetOverdue>(doc, X, y, sheet.overdue.rows, [
        { label: 'Step', width: MW - 110 - 58 - 58, draw: cell((row) => row.step, true) },
        { label: 'Client', width: 110, draw: cell((row) => row.client, false, C.soft) },
        { label: 'Was due', width: 58, draw: cell((row) => row.due, false, C.soft) },
        {
          label: 'Late',
          width: 58,
          align: 'right',
          draw: (d, row, x, yy, w) => {
            d.font('Helvetica-Bold').fontSize(8.5).fillColor(C.red);
            d.text(row.late === 1 ? '1 day' : `${String(row.late)} days`, x, yy + 5, {
              width: w,
              align: 'right',
              lineBreak: false,
            });
          },
        },
      ]);
      y = more(doc, sheet.overdue.more, X, y);
    }

    /* what the author wrote: never cut, so it may run onto another page */
    y = heading(doc, 'In their words', X, y + 14);
    drawWritten(doc, sheet.sections, X, y, MW);
  });
}
