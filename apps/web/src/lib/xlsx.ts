/**
 * Styled .xlsx export built on ExcelJS. Kept separate from the lightweight
 * `csv.ts` helpers — most pages still export CSV; Tasks and Time entries use
 * this richer Excel path (bold/shaded/frozen header row, auto filter, real
 * date/number cell types).
 *
 * ExcelJS is loaded lazily inside `exportXlsx` so its (sizeable) bundle lands in
 * its own chunk and only downloads when a user actually exports.
 */

export interface XlsxColumn<T> {
  header: string;
  /** Field name on the row, or a function deriving the cell value. */
  value: keyof T | ((row: T) => unknown);
  /**
   * Optional link to a DataTable column `key`, so a caller can drop columns the
   * user hid via the table's "Columns" menu before exporting. Columns with no
   * `key` are export-only and always included.
   */
  key?: string;
  /** Cell type — drives Excel formatting. Defaults to 'text'. */
  type?: 'text' | 'number' | 'money' | 'date';
  /** Column width in Excel units. Defaults to a header-length heuristic. */
  width?: number;
}

function readValue<T>(col: XlsxColumn<T>, row: T): unknown {
  return typeof col.value === 'function'
    ? col.value(row)
    : (row as Record<string, unknown>)[col.value as string];
}

function coerce(type: XlsxColumn<unknown>['type'], v: unknown): string | number | boolean | Date | null {
  if (v == null || v === '') return null;
  if (type === 'number' || type === 'money') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d;
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

function stamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const HEADER_FILL = 'FF4F46E5'; // indigo, matches the app accent
const HEADER_BORDER = 'FFE5E7EB';

export async function exportXlsx<T>(opts: {
  /** Filename stem; a `-YYYY-MM-DD.xlsx` suffix is appended. */
  filename: string;
  sheetName: string;
  rows: T[];
  columns: XlsxColumn<T>[];
}): Promise<void> {
  // CJS/ESM interop: depending on the bundler the namespace may sit on `default`.
  const mod = await import('exceljs');
  const ExcelJS = ((mod as { default?: typeof import('exceljs') }).default ?? mod) as typeof import('exceljs');

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = opts.columns.map((c, i) => ({
    header: c.header,
    // Unique positional key — column `key`s may repeat (e.g. two CSV columns
    // both tied to one table column), which ExcelJS would reject.
    key: `c${i}`,
    width: c.width ?? Math.min(Math.max(c.header.length + 4, 12), 48),
    style:
      c.type === 'date'
        ? { numFmt: 'yyyy-mm-dd hh:mm' }
        : c.type === 'money'
          ? { numFmt: '#,##0.00' }
          : c.type === 'number'
            ? { numFmt: '#,##0.##' }
            : {},
  }));

  // Header row styling — bold white text on the accent fill, frozen + filtered.
  const header = ws.getRow(1);
  header.height = 20;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = { bottom: { style: 'thin', color: { argb: HEADER_BORDER } } };
  });

  for (const row of opts.rows) {
    ws.addRow(opts.columns.map((c) => coerce(c.type, readValue(c, row))));
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: opts.columns.length } };

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${opts.filename}-${stamp(new Date())}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
