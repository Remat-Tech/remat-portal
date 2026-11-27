/**
 * What the clients PDFs share: the "dashboard" design the user chose on 25 November 2026 (#291),
 * used by the meeting report and the CEO report (#292). A white header with the Rota icon and a
 * blue rule, a navy sidebar of counts on the first page, and in the main column headings, small
 * bar charts, tables that stop at a few rows, and written sections that are never cut. No
 * "Confidential" in the footer.
 *
 * Drawn in pdfkit's built-in Helvetica: the portal's own web fonts cannot be embedded. pdfkit
 * wraps any text given a width, `lineBreak: false` or not, so a one-line cell is given a height
 * and an ellipsis.
 */

import PDFDocument from 'pdfkit';
import { type CalendarDate, formatDay } from '../../core/calendar/time.js';
import type { PocHealth } from './poc.js';
import { ROTA_LOGO_PNG } from './rota-logo.js';

export const C = {
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

export const HEALTH_COLOUR: Record<PocHealth, string> = {
  ON_TRACK: C.green,
  AT_RISK: C.amber,
  STALLED: C.red,
};

export const HEALTH_NAME: Record<PocHealth, string> = {
  ON_TRACK: 'On Track',
  AT_RISK: 'At Risk',
  STALLED: 'Stalled',
};

export const PAGE = { margin: 36, sidebar: 128, gutter: 18, footer: 46, top: 106 } as const;

export type Doc = PDFKit.PDFDocument;

/** A status pill's colouring: amber for a draft, blue once sent on, grey thrown away. */
export type Tone = 'DRAFT' | 'DONE' | 'DISCARDED';

export interface Column<Row> {
  label: string;
  width: number;
  align?: 'left' | 'right';
  draw: (doc: Doc, row: Row, x: number, y: number, width: number) => void;
}

/** The header every clients PDF has. */
export interface PdfHeader {
  /** "Rota · Clients · Meeting report". */
  label: string;
  /** "1 – 14 November 2026". */
  title: string;
  byline: string;
  status: { text: string; tone: Tone };
}

/**
 * An A4 PDF: `draw` lays out the first page and any after it, and a footer is put on every page,
 * "Page n of N".
 */
export function renderReportPdf(
  info: { title: string; footer: string },
  draw: (doc: Doc) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: true,
      info: { Title: info.title, Author: 'Rota' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    draw(doc);

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      footer(doc, info.footer, index - range.start + 1, range.count);
    }

    doc.end();
  });
}

/** The Rota icon, the label, the title, the byline, the status pill and the blue rule. */
export function drawHeader(doc: Doc, header: PdfHeader): void {
  const W = doc.page.width;
  const M = PAGE.margin;

  doc.image(ROTA_LOGO_PNG, M, 30, { width: 34 });
  smallCaps(doc, header.label, M + 46, 32, C.blue, 7.5);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.ink);
  doc.text(header.title, M + 46, 43, {
    width: W - M * 2 - 46 - 150,
    height: 22,
    ellipsis: true,
  });
  doc.font('Helvetica').fontSize(9).fillColor(C.soft);
  doc.text(header.byline, M + 46, 66, { width: W - M * 2 - 46, height: 11, ellipsis: true });
  const fill = { DRAFT: C.amber, DONE: C.blue, DISCARDED: C.grey }[header.status.tone];
  pillRight(
    doc,
    header.status.text,
    W - M,
    36,
    fill,
    header.status.tone === 'DRAFT' ? C.navy : '#ffffff',
  );
  doc.rect(M, 90, W - M * 2, 2).fill(C.blue);
}

/** The navy sidebar down the first page: each count, big, coral where it warns. */
export function drawSidebar(
  doc: Doc,
  counts: readonly { label: string; value: number; warn: boolean }[],
): void {
  const M = PAGE.margin;
  const top = PAGE.top;
  const height = doc.page.height - top - PAGE.footer - 14;
  doc.roundedRect(M, top, PAGE.sidebar, height, 8).fill(C.navy);

  const step = Math.min(86, (height - 20) / counts.length);
  counts.forEach((count, index) => {
    const y = top + 20 + index * step;
    smallCaps(doc, count.label, M + 16, y, C.sky, 7);
    doc
      .font('Helvetica-Bold')
      .fontSize(34)
      .fillColor(count.warn ? C.coral : '#ffffff');
    doc.text(String(count.value), M + 16, y + 12, { lineBreak: false });
    if (index < counts.length - 1) {
      doc
        .moveTo(M + 16, y + step - 20)
        .lineTo(M + PAGE.sidebar - 16, y + step - 20)
        .lineWidth(0.5)
        .strokeColor(C.navyRule)
        .stroke();
    }
  });
}

/** Where the main column starts, and how wide it is, beside the sidebar. */
export function mainColumn(doc: Doc): { x: number; width: number } {
  const x = PAGE.margin + PAGE.sidebar + PAGE.gutter;
  return { x, width: doc.page.width - PAGE.margin - x };
}

/** Horizontal bars, longest first, each with its count; or a word that there were none. */
export function drawBars(
  doc: Doc,
  bars: readonly { name: string; count: number }[],
  x: number,
  y: number,
  width: number,
  empty: string,
): number {
  if (bars.length === 0) {
    return none(doc, empty, x, y);
  }

  const most = Math.max(...bars.map((bar) => bar.count), 1);
  const track = width - 100;
  for (const bar of bars) {
    doc.font('Helvetica').fontSize(8).fillColor(C.soft);
    doc.text(bar.name, x, y + 1, { width: 72, height: 10, ellipsis: true });
    doc.roundedRect(x + 76, y, track, 9, 4.5).fill(C.blueTint);
    if (bar.count > 0) {
      doc.roundedRect(x + 76, y, Math.max((track * bar.count) / most, 9), 9, 4.5).fill(C.blue);
    }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.ink);
    doc.text(String(bar.count), x + width - 22, y + 1, {
      width: 22,
      align: 'right',
      lineBreak: false,
    });
    y += 16;
  }

  return y;
}

/** The share of POCs at each health as one bar, green, amber and red. */
export function drawHealthBar(
  doc: Doc,
  health: Record<PocHealth, number>,
  x: number,
  y: number,
  width: number,
): number {
  const total = health.ON_TRACK + health.AT_RISK + health.STALLED;
  let sx = x;
  for (const one of ['ON_TRACK', 'AT_RISK', 'STALLED'] as const) {
    if (health[one] === 0) continue;
    const w = (width * health[one]) / total;
    doc.rect(sx, y, Math.max(w - 2, 2), 10).fill(HEALTH_COLOUR[one]);
    sx += w;
  }

  return y + 18;
}

/**
 * Written sections, never cut: each a heading over its words with a blue edge, or a grey one
 * where nothing is written. Runs onto a new page, full width, wherever the page fills.
 */
export function drawWritten(
  doc: Doc,
  sections: readonly { heading: string; body: string | null }[],
  x: number,
  y: number,
  width: number,
): { x: number; y: number; width: number } {
  for (const section of sections) {
    const body = section.body ?? 'Nothing written.';
    doc.font('Helvetica').fontSize(8.5);
    const height = 12 + doc.heightOfString(body, { width: width - 10, lineGap: 1 });

    if (y + height > doc.page.height - PAGE.footer - 10) {
      ({ x, y, width } = newPage(doc));
    }

    doc.rect(x, y, 2.5, height - 2).fill(section.body === null ? C.line : C.blue);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink);
    doc.text(section.heading, x + 10, y, { width: width - 10, height: 11, ellipsis: true });
    doc
      .font(section.body === null ? 'Helvetica-Oblique' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(section.body === null ? C.faint : C.ink);
    doc.text(body, x + 10, y + 12, { width: width - 10, lineGap: 1 });
    y += height + 8;
  }

  return { x, y, width };
}

/** A fresh page with no sidebar: the full width between the margins. */
export function newPage(doc: Doc): { x: number; y: number; width: number } {
  doc.addPage();
  return { x: PAGE.margin, y: PAGE.margin, width: doc.page.width - PAGE.margin * 2 };
}

export function heading(doc: Doc, text: string, x: number, y: number): number {
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text(text, x, y, { lineBreak: false });
  return y + 17;
}

export function none(doc: Doc, text: string, x: number, y: number): number {
  doc
    .font('Helvetica-Oblique')
    .fontSize(8.5)
    .fillColor(C.faint)
    .text(text, x, y, { lineBreak: false });
  return y + 14;
}

export function more(doc: Doc, count: number, x: number, y: number): number {
  if (count === 0) {
    return y;
  }
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.faint);
  doc.text(`+${String(count)} more in the portal`, x + 6, y + 4, { lineBreak: false });
  return y + 14;
}

export function smallCaps(
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
export function cell<Row>(
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

/**
 * A header row, then the rows shaded alternately, each ruled off, and a bold last row where
 * there is one (a total). Returns where it ends.
 */
export function table<Row>(
  doc: Doc,
  x: number,
  y: number,
  rows: readonly Row[],
  columns: Column<Row>[],
  total?: Row,
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
      height: 8,
      ellipsis: true,
    });
    cx += column.width;
  }

  let cy = y + 16;
  const drawRow = (row: Row, shade: string | null) => {
    if (shade !== null) {
      doc.rect(x, cy, width, rowHeight).fill(shade);
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
  };

  rows.forEach((row, index) => {
    drawRow(row, index % 2 === 1 ? C.zebra : null);
  });
  if (total !== undefined) {
    drawRow(total, C.tint);
  }

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
    height: 9,
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
export function capped<Row>(rows: readonly Row[], most: number): { rows: Row[]; more: number } {
  return { rows: rows.slice(0, most), more: Math.max(rows.length - most, 0) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "4 Nov". */
export function shortDay(day: CalendarDate): string {
  return `${String(Number(day.slice(8, 10)))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** "1 – 14 November 2026", "28 October – 14 November 2026", or the one day. */
export function periodInWords(from: CalendarDate, to: CalendarDate): string {
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
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "ama-mensah", for a file name. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
