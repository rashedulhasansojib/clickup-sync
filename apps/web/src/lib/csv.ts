/**
 * Tiny CSV helpers for client-side exports. Keep this dependency-free —
 * pulling in a library for ~30 lines of work isn't worth the bytes.
 *
 * Rules followed (RFC 4180-ish):
 *   • Fields containing comma, double-quote, CR, or LF are wrapped in quotes.
 *   • Inner double-quotes are doubled.
 *   • Rows joined with CRLF (Excel-friendly).
 *   • Output prefixed with UTF-8 BOM so Excel opens non-ASCII names correctly.
 */

export interface CsvColumn<T> {
  header: string;
  /** Field name on the row, or a function deriving the cell value. */
  value: keyof T | ((row: T) => unknown);
  /**
   * Optional link to a DataTable column `key`. When the caller filters its
   * column list against the table's hidden-column set, a CSV column carrying a
   * hidden table key is dropped from the export. CSV-only columns (no table
   * counterpart) leave this undefined and always export.
   */
  key?: string;
}

function csvEscape(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  const s = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => csvEscape(c.header)).join(',');
  const bodyLines = rows.map((row) =>
    columns
      .map((c) => {
        const v = typeof c.value === 'function' ? c.value(row) : (row as Record<string, unknown>)[c.value as string];
        return csvEscape(v);
      })
      .join(','),
  );
  return [headerLine, ...bodyLines].join('\r\n');
}

export function downloadCsv(filename: string, csv: string) {
  // BOM keeps Excel from mangling UTF-8 (assignee names, client names, etc.).
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the blob URL on the next tick — some browsers (Safari) revoke too
  // eagerly if you call right after `click()`.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** "tasks-2026-05-21.csv" */
export function csvFilename(stem: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${stem}-${y}-${m}-${d}.csv`;
}
