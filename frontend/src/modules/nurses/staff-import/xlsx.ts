// Just enough of the .xlsx format for the staff import (D-72), on top of fflate (zip):
// read the cell values of one sheet, and rewrite the "Lists" sheet of the template
// with the live values. A spreadsheet library would be ten times larger than the
// bundle allows (scripts/check-bundle-size.mjs); the template's cells use only a
// handful of XML shapes, which are handled here and covered by tests.

import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';

export type Cell = string | number | boolean | null;
export class XlsxError extends Error {
  constructor(readonly code: 'NOT_XLSX' | 'NO_SHEET', message: string) { super(message); this.name = 'XlsxError'; }
}

const P = '(?:[\\w-]+:)?'; // an optional namespace prefix (some tools write <x:c>)
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITY[e] ?? m));
export const encodeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]!) : null;
};
/** The text of every <t> in a fragment (rich text has several runs; phonetic hints are skipped). */
const texts = (xml: string) => [...xml.replace(new RegExp(`<${P}rPh\\b[\\s\\S]*?</${P}rPh>`, 'g'), '')
  .matchAll(new RegExp(`<${P}t(?:\\s[^>]*)?>([\\s\\S]*?)</${P}t>`, 'g'))].map((m) => decodeXml(m[1]!)).join('');

/** "AB12" → column index 27 (0-based), row 12. */
export function cellRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new XlsxError('NOT_XLSX', `Bad cell reference ${ref}`);
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}
export const colName = (index: number) => {
  let n = index + 1; let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

function open(bytes: Uint8Array): Unzipped {
  try { return unzipSync(bytes); } catch { throw new XlsxError('NOT_XLSX', 'This is not an .xlsx file'); }
}
const text = (files: Unzipped, path: string) => (files[path] ? strFromU8(files[path]!) : null);
/** "xl/workbook.xml" relative targets, or absolute ("/xl/…") ones. */
const resolve = (target: string) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\/\.\//g, '/');

/** The path of each sheet by name, the shared-strings path and the date system. */
function workbook(files: Unzipped) {
  const wb = text(files, 'xl/workbook.xml');
  const rels = text(files, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new XlsxError('NOT_XLSX', 'This is not an .xlsx file');
  const targets = new Map<string, { target: string; type: string }>();
  for (const m of rels.matchAll(new RegExp(`<${P}Relationship\\b([^>]*)/?>`, 'g'))) {
    const id = attr(m[1]!, 'Id'); const target = attr(m[1]!, 'Target'); const type = attr(m[1]!, 'Type') ?? '';
    if (id && target) targets.set(id, { target: resolve(target), type });
  }
  const sheets = new Map<string, string>();
  for (const m of wb.matchAll(new RegExp(`<${P}sheet\\b([^>]*)/?>`, 'g'))) {
    const name = attr(m[1]!, 'name'); const id = attr(m[1]!, 'id');
    const t = id ? targets.get(id) : undefined;
    if (name && t) sheets.set(name, t.target);
  }
  const shared = [...targets.values()].find((t) => t.type.endsWith('/sharedStrings'))?.target ?? null;
  const pr = new RegExp(`<${P}workbookPr\\b([^>]*)/?>`).exec(wb);
  const date1904 = pr ? ['1', 'true'].includes(attr(pr[1]!, 'date1904') ?? '') : false;
  return { wb, sheets, shared, date1904 };
}

/** Every cell of a sheet as rows of values (index = column); formulas give their cached result. */
export function readSheet(bytes: Uint8Array, sheetName: string): { rows: Map<number, Cell[]>; date1904: boolean } {
  const files = open(bytes);
  const { sheets, shared, date1904 } = workbook(files);
  const path = sheets.get(sheetName);
  const xml = path ? text(files, path) : null;
  if (!xml) throw new XlsxError('NO_SHEET', `The file has no sheet named "${sheetName}"`);
  const strings = shared && files[shared]
    ? [...strFromU8(files[shared]!).matchAll(new RegExp(`<${P}si>([\\s\\S]*?)</${P}si>`, 'g'))].map((m) => texts(m[1]!))
    : [];
  const rows = new Map<number, Cell[]>();
  for (const m of xml.matchAll(new RegExp(`<${P}c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${P}c>)`, 'g'))) {
    const attrs = m[1]!; const body = m[2] ?? '';
    const ref = attr(attrs, 'r');
    if (!ref) continue;
    const { col, row } = cellRef(ref);
    const type = attr(attrs, 't') ?? 'n';
    const v = new RegExp(`<${P}v>([\\s\\S]*?)</${P}v>`).exec(body)?.[1];
    let value: Cell = null;
    if (type === 'inlineStr') value = texts(body);
    else if (type === 's') value = v === undefined ? null : (strings[Number(v)] ?? null);
    else if (type === 'str' || type === 'e') value = v === undefined ? null : decodeXml(v);
    else if (type === 'b') value = v === undefined ? null : v === '1';
    else value = v === undefined || v === '' ? null : Number(v);
    if (value === null || value === '') continue;
    const cells = rows.get(row) ?? [];
    cells[col] = value;
    rows.set(row, cells);
  }
  return { rows, date1904 };
}

/** An Excel date serial → YYYY-MM-DD (the 1900 system counts from 30 Dec 1899 for every date after Feb 1900). */
export function serialToIso(serial: number, date1904 = false): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
}

export interface ListsSheet {
  /** Column headers and values, in order; `name` is the defined name the template's drop-downs use. */
  lists: Array<{ header: string; name: string; values: string[] }>;
  /** One column per region after a blank column: "Cities: SA-01" → C_SA_01. */
  cities: Array<{ regionCode: string; values: string[] }>;
}

/**
 * The template with its "Lists" sheet and defined names replaced (everything else — notes, drop-downs,
 * the Check column — stays as it is), and the version line on the Instructions sheet replaced.
 */
export function fillTemplate(template: Uint8Array, data: ListsSheet, versionLine: string): Uint8Array {
  const files = open(template);
  const { wb, sheets } = workbook(files);
  const listsPath = sheets.get('Lists');
  const listsXml = listsPath ? text(files, listsPath) : null;
  if (!listsPath || !listsXml) throw new XlsxError('NO_SHEET', 'The template has no sheet named "Lists"');
  const style = (ref: string, fallback: string) => new RegExp(`<c r="${ref}"[^>]*\\ss="(\\d+)"`).exec(listsXml)?.[1] ?? fallback;
  const sHead = style('A1', '0'); const sCity = style('K1', sHead); const sCell = style('A2', '0');

  const columns: Array<{ header: string; style: string; values: string[]; name: string }> = [
    ...data.lists.map((l) => ({ header: l.header, style: sHead, values: l.values, name: l.name })),
    { header: '', style: sHead, values: [], name: '' }, // a blank column between the lists and the cities
    ...data.cities.map((c) => ({ header: `Cities: ${c.regionCode}`, style: sCity, values: c.values, name: `C_${c.regionCode.replace(/-/g, '_')}` })),
  ];
  const height = Math.max(1, ...columns.map((c) => c.values.length)) + 1;
  const cell = (ref: string, s: string, v: string) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${encodeXml(v)}</t></is></c>`;
  const rows: string[] = [];
  for (let r = 1; r <= height; r++) {
    const cells = columns.map((c, i) => {
      const v = r === 1 ? c.header : c.values[r - 2];
      return v ? cell(`${colName(i)}${r}`, r === 1 ? c.style : sCell, v) : '';
    }).join('');
    rows.push(`<row r="${r}">${cells}</row>`);
  }
  const last = `${colName(columns.length - 1)}${height}`;
  files[listsPath] = strToU8(listsXml
    .replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${last}"/>`)
    .replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData>${rows.join('')}</sheetData>`));

  const names = columns.map((c, i) => (c.name
    ? `<definedName name="${c.name}">Lists!$${colName(i)}$2:$${colName(i)}$${Math.max(2, c.values.length + 1)}</definedName>` : '')).join('');
  files['xl/workbook.xml'] = strToU8(wb.replace(/<definedNames>[\s\S]*?<\/definedNames>/, `<definedNames>${names}</definedNames>`));

  const instr = sheets.get('Instructions');
  const instrXml = instr ? text(files, instr) : null;
  if (instr && instrXml) {
    files[instr] = strToU8(instrXml.replace(/(<c r="A2"[^>]*><is><t[^>]*>)[\s\S]*?(<\/t><\/is><\/c>)/, (_m, a: string, b: string) => `${a}${encodeXml(versionLine)}${b}`));
  }
  return zipSync(files, { level: 6 });
}
