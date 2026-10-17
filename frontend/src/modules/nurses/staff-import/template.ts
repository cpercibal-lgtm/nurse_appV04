// The staff import template, version 3 (D-72): the hospital's version 2 without the Salary column.
// Reading a filled file into API rows, and the live lists for "Download the current template".

import { readSheet, serialToIso, XlsxError, type Cell, type ListsSheet } from './xlsx';

export const MAX_ROWS = 1000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Row 1 of the Staff sheet, exactly. */
export const HEADERS = [
  'Job Number *', 'First Name *', 'Middle Name', 'Last Name *', 'Nationality *', 'Contact E-mail *', 'Mobile Phone',
  'Emergency Contact Phone', 'Unit', 'Position', 'Job Title', 'Rank/Grade *', 'Nursing Specialty *', 'Job Post Region *',
  'Job Post City *', 'Facility *', 'File No.', 'Marital Status', 'Hire Date', 'Contract Type *', 'Contract Start *',
  'Contract End *', 'Check (automatic)',
] as const;
const DATA_COLUMNS = HEADERS.length - 1; // A–V; W is the template's own check

export interface ImportRow {
  rowNumber: number;
  jobNumber: string | null; firstName: string | null; middleName: string | null; lastName: string | null;
  nationalityCode: string | null; contactEmail: string | null; primaryPhone: string | null; emergencyContactPhone: string | null;
  unitCode: string | null; positionCode: string | null; jobTitle: string | null; rankGradeCode: string | null; specialtyCode: string | null;
  jobPostRegionCode: string | null; jobPostCity: string | null; facility: string | null; fileNo: string | null; maritalStatus: string | null;
  hireDate: string | null; contractTypeCode: string | null; contractStart: string | null; contractEnd: string | null;
}

export type ReadProblem =
  | { code: 'NOT_XLSX' | 'NO_SHEET' | 'TOO_LARGE' | 'EMPTY' }
  | { code: 'VERSION_2' }
  | { code: 'WRONG_HEADER'; column: string; expected: string; found: string }
  | { code: 'TOO_MANY_ROWS'; rows: number };

const SEP = ' — ';
/** "ICU_MAIN — Intensive Care" → "ICU_MAIN" (the lists show a code and its name; the code is what is stored). */
export const codeOf = (v: string) => (v.includes(SEP) ? v.slice(0, v.indexOf(SEP)) : v).trim();
/** "Filipino (PHL)" → "PHL"; a bare code is kept. */
export const nationalityOf = (v: string) => /\(([A-Za-z]{3})\)\s*$/.exec(v)?.[1]?.toUpperCase() ?? v.trim();

const textOf = (c: Cell | undefined): string | null => {
  if (c === null || c === undefined) return null;
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(c);
  const s = String(c).trim();
  return s === '' ? null : s;
};
/** Date cells hold Excel serial numbers; text already in YYYY-MM-DD is kept; anything else goes to the server as typed. */
const dateOf = (c: Cell | undefined, date1904: boolean): string | null =>
  (typeof c === 'number' ? serialToIso(c, date1904) : textOf(c));

export type ReadResult = { ok: true; rows: ImportRow[] } | { ok: false; problem: ReadProblem };

/** The filled rows of the Staff sheet, or the first reason the file is not the version 3 template. */
export function readStaffFile(bytes: Uint8Array): ReadResult {
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, problem: { code: 'TOO_LARGE' } };
  let sheet: ReturnType<typeof readSheet>;
  try { sheet = readSheet(bytes, 'Staff'); } catch (e) {
    if (e instanceof XlsxError) return { ok: false, problem: { code: e.code } };
    throw e;
  }
  const header = (sheet.rows.get(1) ?? []).map((c) => textOf(c) ?? '');
  if (header.includes('Salary')) return { ok: false, problem: { code: 'VERSION_2' } };
  for (let i = 0; i < HEADERS.length; i++) {
    if ((header[i] ?? '') !== HEADERS[i]) return { ok: false, problem: { code: 'WRONG_HEADER', column: String.fromCharCode(65 + i), expected: HEADERS[i]!, found: header[i] ?? '' } };
  }
  const rows: ImportRow[] = [];
  for (const [rowNumber, cells] of [...sheet.rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (rowNumber === 1) continue;
    const c = (i: number) => cells[i];
    if (Array.from({ length: DATA_COLUMNS }, (_, i) => textOf(c(i))).every((v) => v === null)) continue; // only the Check formula
    const t = (i: number) => textOf(c(i));
    const code = (i: number) => { const v = t(i); return v === null ? null : codeOf(v); };
    const nat = t(4);
    rows.push({
      rowNumber,
      jobNumber: t(0), firstName: t(1), middleName: t(2), lastName: t(3), nationalityCode: nat === null ? null : nationalityOf(nat),
      contactEmail: t(5), primaryPhone: t(6), emergencyContactPhone: t(7), unitCode: code(8), positionCode: code(9), jobTitle: t(10),
      rankGradeCode: code(11), specialtyCode: code(12), jobPostRegionCode: code(13), jobPostCity: t(14), facility: t(15), fileNo: t(16),
      maritalStatus: t(17), hireDate: dateOf(c(18), sheet.date1904), contractTypeCode: code(19),
      contractStart: dateOf(c(20), sheet.date1904), contractEnd: dateOf(c(21), sheet.date1904),
    });
  }
  if (rows.length === 0) return { ok: false, problem: { code: 'EMPTY' } };
  if (rows.length > MAX_ROWS) return { ok: false, problem: { code: 'TOO_MANY_ROWS', rows: rows.length } };
  return { ok: true, rows };
}

/** GET /employees/import/lists */
export interface ImportLists {
  templateVersion: number; maxRows: number; unassignedAllowed: boolean; generatedAt: string;
  units: Array<{ code: string; name: string }>; positions: Array<{ code: string; title: string }>;
  nationalities: Array<{ code: string; name: string }>; rankGrades: Array<{ code: string; name: string }>;
  specialties: Array<{ code: string; name: string }>; regions: Array<{ code: string; name: string }>;
  citiesByRegion: Record<string, string[]>; facilities: string[]; contractTypes: Array<{ code: string; name: string }>; maritalStatuses: string[];
}

/** The Lists sheet in the template's own format (same headers, "CODE — Name", "Name (CODE)"). */
export function listsSheet(l: ImportLists): ListsSheet {
  const pair = (xs: Array<{ code: string; name: string }>) => xs.map((x) => `${x.code}${SEP}${x.name}`);
  return {
    lists: [
      { header: 'Unit', name: 'L_UNITS', values: pair(l.units) },
      { header: 'Position', name: 'L_POSITIONS', values: l.positions.map((p) => `${p.code}${SEP}${p.title}`) },
      { header: 'Nationality', name: 'L_NATIONALITIES', values: l.nationalities.map((n) => `${n.name} (${n.code})`) },
      { header: 'Rank/Grade', name: 'L_RANKS', values: pair(l.rankGrades) },
      { header: 'Nursing Specialty', name: 'L_SPECIALTIES', values: pair(l.specialties) },
      { header: 'Job Post Region', name: 'L_REGIONS', values: pair(l.regions) },
      { header: 'Facility', name: 'L_FACILITIES', values: l.facilities },
      { header: 'Contract Type', name: 'L_CONTRACT_TYPES', values: pair(l.contractTypes) },
      { header: 'Marital Status', name: 'L_MARITAL', values: l.maritalStatuses },
    ],
    cities: l.regions.map((r) => ({ regionCode: r.code, values: l.citiesByRegion[r.code] ?? [] })),
  };
}

export const versionLine = (l: ImportLists, today: string) =>
  `Version ${l.templateVersion} - lists taken from the live system on ${today}. No Salary column: salary is entered in the application only.`
  + (l.unassignedAllowed ? '' : ' Your access covers only the units listed, so every row needs a Unit.');
