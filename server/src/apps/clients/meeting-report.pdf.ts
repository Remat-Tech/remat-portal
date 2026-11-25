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
 * {@link renderPdf} draws it.
 */

import PDFDocument from 'pdfkit';
import {
  type CalendarDate,
  calendarDateIn,
  formatDay,
  formatInstant,
} from '../../core/calendar/time.js';
import { ACTIVITY_KINDS, type ActivityKind } from './logged-activity.js';
import type { MeetingReportView } from './meeting-report.js';
import { POC_HEALTHS, type PocHealth } from './poc.js';
import { ROTA_LOGO_PNG } from './rota-logo.js';
import { STAGE_NAME } from './stage.js';

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

export const HEALTH_NAME: Record<PocHealth, string> = {
  ON_TRACK: 'On Track',
  AT_RISK: 'At Risk',
  STALLED: 'Stalled',
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
  const author = report.author.name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `meeting-report-${author || 'report'}-${report.period.from}-to-${report.period.to}.pdf`;
}

/* ------------------------------------------------------------------------------ drawing */

const C = {
  navy: '#0c1c3e',
  navyRule: '#2a3b5f',
  blue: '#006afe',
  sky: '#1fc0ff',
  ink: '#14181f',
  soft: '#5b6573',
  faint: '#8a94a3',
  line: '#dde3ec',
  tint: '#f3f6fb',
  zebra: '#fafbfd',
  blueTint: '#eaf2ff',
  coral: '#ff8a80',
  green: '#1e8e3e',
  amber: '#e8a200',
  red: '#b3261e',
  grey: '#8a94a3',
} as const;

const HEALTH_COLOUR: Record<PocHealth, string> = {
  ON_TRACK: C.green,
  AT_RISK: C.amber,
  STALLED: C.red,
};

const PAGE = { margin: 36, sidebar: 128, gutter: 18, footer: 46 } as const;

type Doc = PDFKit.PDFDocument;

interface Column<Row> {
  label: string;
  width: number;
  align?: 'left' | 'right';
  draw: (doc: Doc, row: Row, x: number, y: number, width: number) => void;
}

/** Draws the sheet on A4, the sidebar on the first page and a footer on every one. */
export function renderPdf(sheet: ReportSheet): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: true,
      info: { Title: sheet.title, Author: 'Rota' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    draw(doc, sheet);

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      footer(doc, sheet.footer, index - range.start + 1, range.count);
    }

    doc.end();
  });
}

function draw(doc: Doc, sheet: ReportSheet): void {
  const W = doc.page.width;
  const M = PAGE.margin;

  /* header */
  doc.image(ROTA_LOGO_PNG, M, 30, { width: 34 });
  smallCaps(doc, 'Rota · Clients · Meeting report', M + 46, 32, C.blue, 7.5);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.ink);
  doc.text(sheet.period, M + 46, 43, {
    width: W - M * 2 - 46 - 150,
    lineBreak: false,
    ellipsis: true,
  });
  doc.font('Helvetica').fontSize(9).fillColor(C.soft);
  doc.text(sheet.byline, M + 46, 66, { width: W - M * 2 - 46, lineBreak: false, ellipsis: true });
  const tone = { DRAFT: C.amber, SHARED: C.blue, DISCARDED: C.grey }[sheet.status.tone];
  pillRight(
    doc,
    sheet.status.text,
    W - M,
    36,
    tone,
    sheet.status.tone === 'DRAFT' ? C.navy : '#ffffff',
  );
  doc.rect(M, 90, W - M * 2, 2).fill(C.blue);

  /* sidebar */
  const top = 106;
  const sideH = doc.page.height - top - PAGE.footer - 14;
  doc.roundedRect(M, top, PAGE.sidebar, sideH, 8).fill(C.navy);
  const step = Math.min(86, (sideH - 20) / sheet.counts.length);
  sheet.counts.forEach((count, index) => {
    const y = top + 20 + index * step;
    smallCaps(doc, count.label, M + 16, y, C.sky, 7);
    doc
      .font('Helvetica-Bold')
      .fontSize(34)
      .fillColor(count.warn ? C.coral : '#ffffff');
    doc.text(String(count.value), M + 16, y + 12, { lineBreak: false });
    if (index < sheet.counts.length - 1) {
      doc
        .moveTo(M + 16, y + step - 20)
        .lineTo(M + PAGE.sidebar - 16, y + step - 20)
        .lineWidth(0.5)
        .strokeColor(C.navyRule)
        .stroke();
    }
  });

  /* main column */
  const X = M + PAGE.sidebar + PAGE.gutter;
  const MW = W - M - X;
  const half = (MW - PAGE.gutter) / 2;
  let y = top;

  /* activities by kind, beside the POCs */
  let left = heading(doc, 'Activities by kind', X, y);
  if (sheet.kinds.length === 0) {
    left = none(doc, 'No activities in this period.', X, left);
  } else {
    const most = Math.max(...sheet.kinds.map((one) => one.count));
    const track = half - 100;
    for (const kind of sheet.kinds) {
      doc.font('Helvetica').fontSize(8).fillColor(C.soft);
      doc.text(kind.name, X, left + 1, { width: 72, lineBreak: false, ellipsis: true });
      doc.roundedRect(X + 76, left, track, 9, 4.5).fill(C.blueTint);
      doc.roundedRect(X + 76, left, Math.max((track * kind.count) / most, 9), 9, 4.5).fill(C.blue);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.ink);
      doc.text(String(kind.count), X + half - 22, left + 1, {
        width: 22,
        align: 'right',
        lineBreak: false,
      });
      left += 16;
    }
  }

  const PX = X + half + PAGE.gutter;
  let right = heading(doc, 'POC health', PX, y);
  const pocTotal = POC_HEALTHS.reduce((sum, one) => sum + sheet.pocs.health[one], 0);
  if (pocTotal === 0) {
    right = none(doc, 'No POCs in this period.', PX, right);
  } else {
    let sx = PX;
    for (const one of POC_HEALTHS) {
      const n = sheet.pocs.health[one];
      if (n === 0) continue;
      const w = (half * n) / pocTotal;
      doc.rect(sx, right, Math.max(w - 2, 2), 10).fill(HEALTH_COLOUR[one]);
      sx += w;
    }
    right += 18;
    for (const poc of sheet.pocs.rows) {
      doc.circle(PX + 4, right + 4, 3.2).fill(HEALTH_COLOUR[poc.health]);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
      doc.text(poc.client, PX + 12, right, { width: half * 0.6 - 14, height: 10, ellipsis: true });
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

  y = Math.max(left, right) + 16;

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
  let x = X;
  let width = MW;
  for (const section of sheet.sections) {
    const body = section.body ?? 'Nothing written.';
    doc.font('Helvetica').fontSize(8.5);
    const height = 12 + doc.heightOfString(body, { width: width - 10, lineGap: 1 });

    if (y + height > doc.page.height - PAGE.footer - 10) {
      doc.addPage();
      x = PAGE.margin;
      width = doc.page.width - PAGE.margin * 2;
      y = PAGE.margin;
    }

    doc.rect(x, y, 2.5, height - 2).fill(section.body === null ? C.line : C.blue);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
    doc.text(section.heading, x + 10, y, { width: width - 10, lineBreak: false, ellipsis: true });
    doc
      .font(section.body === null ? 'Helvetica-Oblique' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(section.body === null ? C.faint : C.ink);
    doc.text(body, x + 10, y + 12, { width: width - 10, lineGap: 1 });
    y += height + 8;
  }
}

function heading(doc: Doc, text: string, x: number, y: number): number {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(text, x, y, { lineBreak: false });
  return y + 17;
}

function none(doc: Doc, text: string, x: number, y: number): number {
  doc
    .font('Helvetica-Oblique')
    .fontSize(8.5)
    .fillColor(C.faint)
    .text(text, x, y, { lineBreak: false });
  return y + 14;
}

function more(doc: Doc, count: number, x: number, y: number): number {
  if (count === 0) {
    return y;
  }
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.faint);
  doc.text(`+${String(count)} more in the portal`, x + 6, y + 4, { lineBreak: false });
  return y + 14;
}

function smallCaps(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  colour: string,
  size: number,
): void {
  doc.font('Helvetica-Bold').fontSize(size).fillColor(colour);
  doc.text(text.toUpperCase(), x, y, { characterSpacing: 0.8, lineBreak: false });
}

/** A pill whose right edge is at `right`. */
function pillRight(
  doc: Doc,
  text: string,
  right: number,
  y: number,
  fill: string,
  ink: string,
): void {
  doc.font('Helvetica-Bold').fontSize(7);
  const w = doc.widthOfString(text) + 14;
  doc.roundedRect(right - w, y, w, 15, 7.5).fill(fill);
  doc.fillColor(ink).text(text, right - w + 7, y + 4, { lineBreak: false });
}

/** A plain cell: one line, cut with an ellipsis where it does not fit. */
function cell<Row>(
  value: (row: Row) => string,
  bold: boolean,
  colour: string = C.ink,
  align: 'left' | 'right' = 'left',
): Column<Row>['draw'] {
  return (doc, row, x, y, width) => {
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(colour);
    doc.text(value(row), x, y + 5, { width, align, height: 10, ellipsis: true });
  };
}

/** A header row, then the rows shaded alternately, each ruled off. Returns where it ends. */
function table<Row>(
  doc: Doc,
  x: number,
  y: number,
  rows: readonly Row[],
  columns: Column<Row>[],
): number {
  const width = columns.reduce((sum, column) => sum + column.width, 0);
  const rowHeight = 17;

  doc.rect(x, y, width, 16).fill(C.tint);
  let cx = x;
  for (const column of columns) {
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.soft);
    doc.text(column.label.toUpperCase(), cx + 6, y + 5.5, {
      width: column.width - 12,
      align: column.align ?? 'left',
      characterSpacing: 0.8,
      lineBreak: false,
    });
    cx += column.width;
  }

  let cy = y + 16;
  rows.forEach((row, index) => {
    if (index % 2 === 1) {
      doc.rect(x, cy, width, rowHeight).fill(C.zebra);
    }
    let cellX = x;
    for (const column of columns) {
      column.draw(doc, row, cellX + 6, cy, column.width - 12);
      cellX += column.width;
    }
    cy += rowHeight;
    doc
      .moveTo(x, cy)
      .lineTo(x + width, cy)
      .lineWidth(0.5)
      .strokeColor(C.line)
      .stroke();
  });

  return cy;
}

function footer(doc: Doc, text: string, page: number, pages: number): void {
  const y = doc.page.height - 30;
  const W = doc.page.width;
  doc
    .moveTo(PAGE.margin, y - 8)
    .lineTo(W - PAGE.margin, y - 8)
    .lineWidth(0.5)
    .strokeColor(C.line)
    .stroke();
  doc.font('Helvetica').fontSize(7).fillColor(C.faint);
  doc.text(text, PAGE.margin, y, {
    width: W - PAGE.margin * 2 - 80,
    lineBreak: false,
    ellipsis: true,
  });
  doc.text(`Page ${String(page)} of ${String(pages)}`, W - PAGE.margin - 80, y, {
    width: 80,
    align: 'right',
    lineBreak: false,
  });
}

/* ---------------------------------------------------------------------------- the words */

/** The first rows, and how many more there are. */
function capped<Row>(rows: readonly Row[], most: number): { rows: Row[]; more: number } {
  return { rows: rows.slice(0, most), more: Math.max(rows.length - most, 0) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "4 Nov". */
function shortDay(day: CalendarDate): string {
  return `${String(Number(day.slice(8, 10)))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** "1 – 14 November 2026", "28 October – 14 November 2026", or the one day. */
function periodInWords(from: CalendarDate, to: CalendarDate): string {
  if (from === to) {
    return formatDay(from);
  }
  const last = formatDay(to);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${String(Number(from.slice(8, 10)))} – ${last}`;
  }
  if (from.slice(0, 4) === to.slice(0, 4)) {
    const first = formatDay(from);
    return `${first.slice(0, first.lastIndexOf(' '))} – ${last}`;
  }
  return `${formatDay(from)} – ${last}`;
}

/** Whole days from one calendar day to a later one. */
function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
