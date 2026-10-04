// Sensitive personal data in credential records (spec §8.3, PDPL; D-54).
//
// A credential type marks a text field with a PDPL category (IQAMA, PASSPORT,
// SCFHS_REG). Such a value is never stored in clear:
// - on write it is sealed with the employee's own data key (lib/field-crypto)
//   and indexed by an HMAC digest for exact search;
// - it may be written only while the processing register (§8.3.2) has an
//   active lawful basis for its category — otherwise 409
//   PROCESSING_NOT_REGISTERED;
// - on read it is opened for the same callers who could read it before; if
//   the employee's key was destroyed (erasure, §8.3.3) the value reads as
//   null and the record says so.

import { HttpError } from '../../lib/http-errors.js';
import { isSealed, PDPL_CATEGORIES, type FieldCrypto, type PdplCategory } from '../../lib/field-crypto.js';
import type { DbClient } from '../../lib/prisma.js';

export type TrackingValues = Record<string, string | number>;
interface SensitiveField { key: string; pdplCategory?: PdplCategory | null }

export function createProtection(crypto: FieldCrypto) {
  /** The employee's data key, created on first use. Null when it was destroyed (erasure). */
  async function dataKey(tx: DbClient, employeeId: number, create: boolean): Promise<Buffer | null> {
    let row = await tx.employeeKey.findUnique({ where: { employeeId } });
    if (!row && create) {
      await tx.employeeKey.createMany({ data: [{ employeeId, wrappedKey: crypto.newWrappedKey(employeeId), keyVersion: crypto.masterKeyId }], skipDuplicates: true });
      row = await tx.employeeKey.findUnique({ where: { employeeId } });
    }
    if (!row?.wrappedKey) return null;
    return crypto.unwrapKey(employeeId, row.wrappedKey);
  }

  async function assertRegistered(tx: DbClient, categories: Set<PdplCategory>) {
    if (categories.size === 0) return;
    const active = await tx.processingRegister.findMany({ where: { dataCategory: { in: [...categories] }, isActive: true }, select: { dataCategory: true } });
    const missing = [...categories].filter((c) => !active.some((a) => a.dataCategory === c));
    if (missing.length > 0) {
      throw new HttpError(409, 'PROCESSING_NOT_REGISTERED', `No active lawful basis is recorded for ${missing.join(', ')} (Nursing Administration → Data protection). The value was not stored.`, { categories: missing });
    }
  }

  return {
    /**
     * Seals the sensitive values of validated tracking data. Throws if the employee's key was erased.
     * `checkRegister: false` only for erasure, which seals leftover plaintext just before destroying the key.
     */
    async seal(tx: DbClient, employeeId: number, fields: SensitiveField[], data: TrackingValues, { checkRegister = true } = {}): Promise<TrackingValues> {
      const sensitive = fields.filter((f) => f.pdplCategory && data[f.key] !== undefined && data[f.key] !== '' && !isSealed(data[f.key]));
      if (sensitive.length === 0) return data;
      if (checkRegister) await assertRegistered(tx, new Set(sensitive.map((f) => f.pdplCategory!)));
      const key = await dataKey(tx, employeeId, true);
      if (!key) throw new HttpError(409, 'PERSONAL_DATA_ERASED', 'This employee\'s sensitive data was erased; it cannot be recorded again');
      const out = { ...data };
      for (const f of sensitive) out[f.key] = crypto.seal(key, employeeId, f.key, String(data[f.key]));
      return out;
    },

    /** Replaces the credential's blind-index rows from its current plaintext values. */
    async index(tx: DbClient, credentialId: number, fields: SensitiveField[], plain: TrackingValues) {
      await tx.pdplIdentifierIndex.deleteMany({ where: { credentialId } });
      const rows = fields.filter((f) => f.pdplCategory && typeof plain[f.key] === 'string' && plain[f.key] !== '' && !isSealed(plain[f.key]))
        .map((f) => ({ credentialId, category: f.pdplCategory!, digest: crypto.blindIndex(f.pdplCategory!, String(plain[f.key])), keyVersion: crypto.pepperId }));
      if (rows.length > 0) await tx.pdplIdentifierIndex.createMany({ data: rows });
    },

    /** Opens every sealed value; `erased` when the employee's key is gone (the values read as null). */
    async reveal(tx: DbClient, employeeId: number, data: unknown, cache?: Map<number, Buffer | null>): Promise<{ data: unknown; erased: boolean }> {
      if (!data || typeof data !== 'object') return { data, erased: false };
      const entries = Object.entries(data as Record<string, unknown>);
      if (!entries.some(([, v]) => isSealed(v))) return { data, erased: false };
      let key = cache?.get(employeeId);
      if (key === undefined) {
        key = await dataKey(tx, employeeId, false);
        cache?.set(employeeId, key);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of entries) out[k] = isSealed(v) ? (key ? crypto.open(key, employeeId, k, v) : null) : v;
      return { data: out, erased: key === null };
    },

    /** Credential ids whose identifier (any category) equals `value`. */
    async findByIdentifier(tx: DbClient, value: string) {
      const digests = PDPL_CATEGORIES.flatMap((c) => crypto.searchDigests(c, value));
      const rows = await tx.pdplIdentifierIndex.findMany({ where: { digest: { in: digests } }, select: { credentialId: true } });
      return [...new Set(rows.map((r) => r.credentialId))];
    },
    /**
     * Erasure by crypto-shredding (spec §8.3.3, D-55): destroys the employee's data key, so every
     * value sealed with it is unreadable for good, and drops their search-index rows. The caller
     * seals any leftover plaintext first. Throws 409 ALREADY_ERASED when the key is already gone.
     */
    async destroyKey(tx: DbClient, employeeId: number, now: Date) {
      const row = await tx.employeeKey.findUnique({ where: { employeeId } });
      if (row?.destroyedAt) throw new HttpError(409, 'ALREADY_ERASED', `This employee's sensitive data was already erased on ${row.destroyedAt.toISOString()}`);
      if (row) await tx.employeeKey.update({ where: { employeeId }, data: { wrappedKey: null, destroyedAt: now } });
      else await tx.employeeKey.create({ data: { employeeId, wrappedKey: null, destroyedAt: now } }); // no key yet: nothing may be sealed later either
      await tx.pdplIdentifierIndex.deleteMany({ where: { credential: { employeeId } } });
    },
    dataKey,
    crypto,
  };
}

export type Protection = ReturnType<typeof createProtection>;
