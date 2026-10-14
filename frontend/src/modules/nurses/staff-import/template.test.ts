// The staff import template (D-72): reading filled files (as written by openpyxl and as re-saved
// with shared strings, like Excel), refusing version 2 and wrong files, and the live template.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { codeOf, HEADERS, listsSheet, nationalityOf, readStaffFile, versionLine, type ImportLists } from './template';
import { cellRef, colName, decodeXml, fillTemplate, readSheet, serialToIso } from './xlsx';

const file = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, name)));
const TEMPLATE = file('AIGH_Staff_Import_Template_v3.xlsx');

describe('xlsx helpers', () => {
  it('cell references, column names, entities and Excel dates', () => {
    expect(cellRef('A1')).toEqual({ col: 0, row: 1 });
    expect(cellRef('AB12')).toEqual({ col: 27, row: 12 });
    expect([0, 25, 26, 27, 51, 52].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
    expect(decodeXml('A &amp; B &lt;x&gt; &#8212; &#x41;')).toBe('A & B <x> — A');
    expect(serialToIso(46326)).toBe('2026-10-31');
    expect(serialToIso(46326 - 1462, true)).toBe('2026-10-31');
  });

  it('codes and nationalities from the list values', () => {
    expect(codeOf('ICU_MAIN — Intensive Care')).toBe('ICU_MAIN');
    expect(codeOf('SN')).toBe('SN');
    expect(nationalityOf('Filipino (PHL)')).toBe('PHL');
    expect(nationalityOf('sau')).toBe('sau');
  });
});

describe('readStaffFile', () => {
  for (const name of ['fixtures/filled-v3.xlsx', 'fixtures/filled-v3-excel-style.xlsx']) {
    it(`reads the filled rows of ${name}`, () => {
      const out = readStaffFile(file(name));
      if (!out.ok) throw new Error(JSON.stringify(out.problem));
      expect(out.rows.map((r) => r.rowNumber)).toEqual([2, 3, 10]);
      expect(out.rows[0]).toEqual({
        rowNumber: 2, jobNumber: 'T9001', firstName: 'Sara', middleName: null, lastName: 'Example', nationalityCode: 'PHL',
        contactEmail: 'sara.example@example.com', primaryPhone: '+966501234567', emergencyContactPhone: null, unitCode: 'ACADEMIC',
        positionCode: null, jobTitle: 'Staff Nurse', rankGradeCode: 'N03', specialtyCode: 'NS003', jobPostRegionCode: 'SA-05',
        jobPostCity: 'Buraydah', facility: 'Al Iman General Hospital', fileNo: null, maritalStatus: 'Single', hireDate: '2026-10-01',
        contractTypeCode: 'DIRECT_HOSPITAL', contractStart: '2026-11-01', contractEnd: '2027-10-31',
      });
      // A numeric job number, characters that need escaping, an empty text cell, a date typed as text.
      expect(out.rows[1]).toMatchObject({ jobNumber: '10234', firstName: 'Ahmed & Co', lastName: 'Test <x>', nationalityCode: 'SAU', jobTitle: null,
        positionCode: 'SN', unitCode: null, primaryPhone: '+966 50 000 0001', contractStart: '2026-11-01', contractEnd: '2027-10-31', hireDate: null });
      expect(out.rows[2]).toMatchObject({ jobNumber: 'T9010', firstName: 'Late', lastName: 'Row', contactEmail: null });
    });
  }

  it('refuses version 2 (it has a Salary column), a wrong header, an empty template and a file that is not .xlsx', () => {
    expect(readStaffFile(file('fixtures/version-2.xlsx'))).toEqual({ ok: false, problem: { code: 'VERSION_2' } });
    expect(readStaffFile(TEMPLATE)).toEqual({ ok: false, problem: { code: 'EMPTY' } });
    expect(readStaffFile(strToU8('Job Number,First Name\n1,2'))).toEqual({ ok: false, problem: { code: 'NOT_XLSX' } });
    const files = unzipSync(file('fixtures/filled-v3.xlsx'));
    const sheet = 'xl/worksheets/sheet2.xml';
    files[sheet] = strToU8(strFromU8(files[sheet]!).replace('<t>Job Title</t>', '<t>Title</t>'));
    expect(readStaffFile(zipSync(files))).toEqual({ ok: false, problem: { code: 'WRONG_HEADER', column: 'K', expected: 'Job Title', found: 'Title' } });
    expect(HEADERS).toHaveLength(23);
  });

  it('refuses more than 1,000 people and files over 5 MB', () => {
    const files = unzipSync(file('fixtures/filled-v3.xlsx'));
    const sheet = 'xl/worksheets/sheet2.xml';
    const extra = Array.from({ length: 1001 }, (_, i) => `<row r="${2000 + i}"><c r="A${2000 + i}" t="inlineStr"><is><t>X${i}</t></is></c></row>`).join('');
    files[sheet] = strToU8(strFromU8(files[sheet]!).replace('</sheetData>', `${extra}</sheetData>`));
    expect(readStaffFile(zipSync(files))).toEqual({ ok: false, problem: { code: 'TOO_MANY_ROWS', rows: 1004 } });
    expect(readStaffFile(new Uint8Array(5 * 1024 * 1024 + 1))).toEqual({ ok: false, problem: { code: 'TOO_LARGE' } });
  });
});

describe('the current template (live lists)', () => {
  const lists: ImportLists = {
    templateVersion: 3, maxRows: 1000, unassignedAllowed: false, generatedAt: '2026-10-14T00:00:00Z',
    units: [{ code: 'ICU_A', name: 'ICU & Recovery' }], positions: [{ code: 'SN', title: 'Staff Nurse' }],
    nationalities: [{ code: 'SAU', name: 'Saudi' }, { code: 'PHL', name: 'Filipino' }], rankGrades: [{ code: 'N03', name: 'Specialist Nurse' }],
    specialties: [{ code: 'NS003', name: 'Critical Care Nursing / ICU' }],
    regions: [{ code: 'SA-01', name: 'Riyadh Region' }, { code: 'SA-15', name: 'New Region' }],
    citiesByRegion: { 'SA-01': ['Riyadh', 'Al Kharj'], 'SA-15': ['New City'] }, facilities: ['Al Iman General Hospital'],
    contractTypes: [{ code: 'HHC', name: 'Health Holding Company' }], maritalStatuses: ['Single', 'Married', 'Others'],
  };
  const out = fillTemplate(TEMPLATE, listsSheet(lists), versionLine(lists, '2026-10-14'));

  it('replaces the Lists sheet and the drop-down names, in the template\'s format', () => {
    const sheet = readSheet(out, 'Lists').rows;
    expect(sheet.get(1)!.slice(0, 9)).toEqual(['Unit', 'Position', 'Nationality', 'Rank/Grade', 'Nursing Specialty', 'Job Post Region', 'Facility', 'Contract Type', 'Marital Status']);
    expect(sheet.get(1)![10]).toBe('Cities: SA-01');
    expect(sheet.get(1)![11]).toBe('Cities: SA-15');
    expect(sheet.get(2)!.slice(0, 9)).toEqual(['ICU_A — ICU & Recovery', 'SN — Staff Nurse', 'Saudi (SAU)', 'N03 — Specialist Nurse',
      'NS003 — Critical Care Nursing / ICU', 'SA-01 — Riyadh Region', 'Al Iman General Hospital', 'HHC — Health Holding Company', 'Single']);
    expect(sheet.get(3)![2]).toBe('Filipino (PHL)');
    expect(sheet.get(3)![10]).toBe('Al Kharj');
    expect(sheet.get(5)).toBeUndefined(); // nothing left over from the old, longer lists
    const wb = strFromU8(unzipSync(out)['xl/workbook.xml']!);
    expect(wb).toContain('<definedName name="L_UNITS">Lists!$A$2:$A$2</definedName>');
    expect(wb).toContain('<definedName name="L_NATIONALITIES">Lists!$C$2:$C$3</definedName>');
    expect(wb).toContain('<definedName name="C_SA_01">Lists!$K$2:$K$3</definedName>');
    expect(wb).toContain('<definedName name="C_SA_15">Lists!$L$2:$L$2</definedName>');
    expect(wb).not.toContain('C_SA_02');
  });

  it('keeps the Staff sheet (drop-downs, notes, the Check column) and updates the version line', () => {
    const before = unzipSync(TEMPLATE); const after = unzipSync(out);
    expect(strFromU8(after['xl/worksheets/sheet2.xml']!)).toBe(strFromU8(before['xl/worksheets/sheet2.xml']!));
    expect(after['xl/comments/comment1.xml']).toEqual(before['xl/comments/comment1.xml']);
    expect(readSheet(out, 'Instructions').rows.get(2)![0]).toBe(versionLine(lists, '2026-10-14'));
    expect(versionLine(lists, '2026-10-14')).toContain('every row needs a Unit');
    // A downloaded template reads back as an empty version 3 file.
    expect(readStaffFile(out)).toEqual({ ok: false, problem: { code: 'EMPTY' } });
  });
});
