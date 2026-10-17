// Hospital exit package (spec §14.3, D-62): the ZIP holds the workforce, contracts,
// credentials with sensitive values opened, decrypted evidence under the standard
// names, the audit log whose hashes a recipient can recompute, and a manifest
// that checks. Unreadable and erased evidence is listed, never fatal.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, writeExitPackage } from '../src/cli/exit-package.js';
import { fieldCryptoFromEnv } from '../src/lib/field-crypto.js';
import type { Db } from '../src/lib/prisma.js';
import { createLocalDiskAdapter, createVault, type Vault } from '../src/lib/vault.js';
import { fieldRows } from '../src/modules/credentials/fields.js';
import type { FieldDef } from '../src/modules/credentials/catalog.js';
import { createProtection, type Protection } from '../src/modules/pdpl/protection.js';
import { makeNurse, makeOrg, openDb, TEST_URL, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/** RFC 4180 rows (quoted cells may hold commas, quotes and line breaks). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += ch;
  }
  return rows;
}

describe('exit package CSV cells', () => {
  it('quotes when needed and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(null)).toBe('');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describeDb('exit package (spec §14.3)', () => {
  let db: Db;
  let root: string;
  let vault: Vault;
  let protection: Protection;

  beforeAll(async () => {
    db = openDb();
    root = await mkdtemp(join(tmpdir(), 'exit-'));
    vault = createVault(createLocalDiskAdapter(join(root, 'vault')), crypto.randomBytes(32));
    protection = createProtection(fieldCryptoFromEnv(testEnv()));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); await db.$disconnect(); });

  it('packages workforce, contracts, opened credentials, named evidence, a verifiable audit log and a manifest', async () => {
    const org = await makeOrg(db);
    const { emp } = await makeNurse(db, org.unitA.id);
    await db.employee.update({ where: { id: emp.id }, data: { specialty: '=cmd|calc' } });
    const contract = await db.contract.findFirstOrThrow({ where: { employeeId: emp.id } });

    // A credential whose Iqama number is stored sealed.
    await db.credentialCategory.upsert({ where: { code: 'IDENTITY' }, update: {}, create: { code: 'IDENTITY', name: 'Identity' } });
    const code = uniq('IQ').toUpperCase();
    const t = await db.credentialTemplate.create({ data: { code, name: 'Iqama', categoryCode: 'IDENTITY', hasExpiry: false, requiresUpload: true } });
    const defs: FieldDef[] = [{ key: 'iqama_number', label: 'Iqama', type: 'text', required: true, displayOrder: 1, pdplCategory: 'IQAMA' }];
    await db.credentialTemplateField.createMany({ data: fieldRows(t.id, defs) });
    const iqama = String(2_000_000_000 + Math.floor(Math.random() * 999_999_999));
    const sealed = await protection.seal(db, emp.id, [{ key: 'iqama_number', pdplCategory: 'IQAMA' }], { iqama_number: iqama });
    const cred = await db.credential.create({ data: { employeeId: emp.id, templateId: t.id, status: 'Valid', trackingData: sealed } });

    // Evidence: a credential scan, a contract file, an erased one and one missing from storage.
    const pdf = Buffer.from(`%PDF-1.7 evidence ${uniq('x')}\n%%EOF\n`);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const doc = (data: object) => db.documentVersion.create({ data: { version: 1, sizeBytes: 1, scanStatus: 'CLEAN', uploadedAt: new Date('2026-03-04T09:00:00Z'), ...data } as never });
    const d1 = await doc({ credentialId: cred.id, fileName: 'scan.pdf', mimeType: 'application/pdf', sha256: sha(pdf), storageKey: await vault.put(pdf) });
    await doc({ contractId: contract.id, fileName: 'contract.png', mimeType: 'image/png', sha256: sha(png), storageKey: await vault.put(png) });
    const erasedBytes = Buffer.from('erased');
    await db.documentVersion.create({ data: { credentialId: cred.id, version: 2, fileName: 'old.pdf', mimeType: 'application/pdf', sizeBytes: 6, sha256: sha(erasedBytes), storageKey: uniq('gone'), erasedAt: new Date() } });
    const missing = await db.documentVersion.create({ data: { credentialId: cred.id, version: 3, fileName: 'lost.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: sha('x'), storageKey: uniq('missing') } });

    const zipPath = join(root, 'package.zip');
    const summary = await writeExitPackage(db, { protection, vault }, createWriteStream(zipPath));
    const bytes = await readFile(zipPath);
    expect(summary).toMatchObject({ bytes: bytes.length, sha256: sha(bytes) });
    expect(summary.evidenceUnreadable.map((u) => u.documentId)).toContain(missing.id);

    const dir = join(root, 'out');
    if (process.platform === 'win32') {
      await mkdir(dir);
      // Windows' own bsdtar reads ZIP; the GNU tar of Git Bash, often first on PATH, does not.
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zipPath, '-C', dir]);
    } else {
      execFileSync('unzip', ['-q', zipPath, '-d', dir]);
    }
    // Every entry is listed in the manifest with the right hash.
    const manifestLines = (await readFile(join(dir, 'MANIFEST.sha256'), 'utf8')).trim().split('\n');
    for (const line of manifestLines) {
      const name = line.slice(66);
      expect(sha(await readFile(join(dir, name))), name).toBe(line.slice(0, 64));
    }
    const manifest = manifestLines.map((l) => l.slice(66));
    expect(manifest).toEqual(expect.arrayContaining(['README.txt', 'organisation.json', 'accounts.json', 'workforce_master.json', 'workforce_master.csv', 'contract_history.json', 'contract_events.csv', 'credential_archive.json', 'audit_manifest.csv']));

    // Evidence: decrypted, under the standard names.
    const tag = (c: string) => `evidence_archive/EMP_${emp.id}_${c}_20260304`;
    expect(await readFile(join(dir, `${tag(code)}.pdf`))).toEqual(pdf);
    expect(await readFile(join(dir, `${tag('CONTRACT')}.png`))).toEqual(png);

    // Credentials with the sensitive value opened; erased and unreadable evidence listed.
    const archive = JSON.parse(await readFile(join(dir, 'credential_archive.json'), 'utf8'));
    const c = archive.credentials.find((x: { id: number }) => x.id === cred.id);
    expect(c.trackingData).toEqual({ iqama_number: iqama });
    expect(c.evidence.map((e: { documentId: number; state: string; archivePath: string | null }) => [e.documentId, e.state, e.archivePath]))
      .toEqual(expect.arrayContaining([[d1.id, 'included', `${tag(code)}.pdf`], [missing.id, 'unreadable', null], [expect.any(Number), 'erased', null]]));
    expect(JSON.stringify(JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')))).not.toMatch(/passwordHash|secretEnc/);

    // Workforce: exact in JSON, neutralised in CSV.
    const workforce = JSON.parse(await readFile(join(dir, 'workforce_master.json'), 'utf8'));
    expect(workforce.find((w: { id: number }) => w.id === emp.id)).toMatchObject({ jobNumber: emp.jobNumber, specialty: '=cmd|calc' });
    expect(await readFile(join(dir, 'workforce_master.csv'), 'utf8')).toContain("'=cmd|calc");
    expect(JSON.parse(await readFile(join(dir, 'contract_history.json'), 'utf8')).some((x: { id: number }) => x.id === contract.id)).toBe(true);

    // The audit log: every row's hash recomputes from the documented formula; the chain links.
    const [header, ...rows] = parseCsv(await readFile(join(dir, 'audit_manifest.csv'), 'utf8'));
    expect(header).toEqual(['id', 'previous_hash', 'hash', 'actor_user_id', 'action', 'resource', 'resource_id', 'changes', 'request_id', 'priority', 'created_at']);
    expect(rows.length).toBe(summary.auditEntries);
    for (const [i, r] of rows.entries()) {
      const [id, prev, hash, actor, action, resource, rid, changes, req, priority, at] = r as string[];
      expect(sha([prev, actor, action, resource, rid, changes, req, priority, at].join('|')), `audit row ${id}`).toBe(hash);
      const before = rows[i - 1];
      if (before && Number(before[0]) === Number(id) - 1) expect(prev).toBe(before[2]);
    }
    const readme = await readFile(join(dir, 'README.txt'), 'utf8');
    expect(readme).toContain('PERSONAL DATA IN CLEAR');
    expect(readme).toContain(`document ${missing.id}:`);
  });
});
