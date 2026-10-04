// Field-level protection of sensitive personal data (spec §8.3.4, PDPL; D-54).
//
// - Encryption: each employee has a random 256-bit data key, stored only
//   wrapped (AES-256-GCM) by PDPL_FIELD_ENCRYPTION_KEY in employee_keys. A
//   sensitive value is sealed with that employee key as
//   "pdpl:v1:<iv|ciphertext|tag, base64url>", the employee and field bound in
//   as additional data. Destroying the employee's key (erasure, spec §8.3.3)
//   makes every such value unreadable at once — crypto-shredding.
// - Blind index: HMAC-SHA256 of the normalised value, keyed with
//   PDPL_BLIND_INDEX_PEPPER (never stored in the database), lets HR find a
//   record by an exact identifier without the database holding it in clear.
//   Digests carry their key version, for pepper rotation.
// - Rotation (B-18): with PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS set, employee
//   keys wrapped under either master key open; with
//   PDPL_BLIND_INDEX_PEPPER_PREVIOUS set, a search also matches digests made
//   with the old pepper. `npm run keys:rotate` re-wraps and re-indexes; the
//   key_version columns hold the key id (lib/keyring) to count what is left.

import crypto from 'node:crypto';
import { keyId, previousKey, withEither } from './keyring.js';

export const SEALED_PREFIX = 'pdpl:v1:';
export const BLIND_KEY_VERSION = 1;
export const PDPL_CATEGORIES = ['IQAMA', 'PASSPORT', 'SCFHS_REG', 'NATIONAL_ID'] as const;
export type PdplCategory = (typeof PDPL_CATEGORIES)[number];

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(SEALED_PREFIX);

const aad = (employeeId: number, field: string) => Buffer.from(`pdpl:employee:${employeeId}:field:${field}`, 'utf8');

function gcm(key: Buffer, plain: Buffer, extra: Buffer) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(extra);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function ungcm(key: Buffer, packed: Buffer, extra: Buffer) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  d.setAAD(extra);
  d.setAuthTag(packed.subarray(packed.length - 16));
  return Buffer.concat([d.update(packed.subarray(12, packed.length - 16)), d.final()]);
}

export interface PreviousKeys { masterKey?: Buffer | null; pepper?: Buffer | null }

export function createFieldCrypto(masterKey: Buffer, pepper: Buffer, previous: PreviousKeys = {}) {
  const oldMaster = previous.masterKey ?? null;
  const oldPepper = previous.pepper ?? null;
  if (masterKey.length !== 32 || (oldMaster && oldMaster.length !== 32)) throw new Error('PDPL_FIELD_ENCRYPTION_KEY must be 32 bytes (base64 of 32 random bytes)');
  if (pepper.length !== 32 || (oldPepper && oldPepper.length !== 32)) throw new Error('PDPL_BLIND_INDEX_PEPPER must be 32 bytes (base64 of 32 random bytes)');
  const wrapAad = (employeeId: number) => Buffer.from(`pdpl:employee-key:${employeeId}`, 'utf8');
  const digest = (key: Buffer, category: PdplCategory, value: string) => {
    const normalised = value.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
    return crypto.createHmac('sha256', key).update(`${category}:${normalised}`).digest('hex');
  };
  const unwrap = (employeeId: number, wrapped: string) =>
    withEither(masterKey, oldMaster, (k) => ungcm(k, Buffer.from(wrapped, 'base64url'), wrapAad(employeeId))).value;
  return {
    /** Ids of the current master key and pepper, stored in the key_version columns. */
    masterKeyId: keyId(masterKey),
    pepperId: keyId(pepper),
    rotating: { masterKey: oldMaster !== null, pepper: oldPepper !== null },
    /** A new employee data key, wrapped for storage. */
    newWrappedKey(employeeId: number) {
      return gcm(masterKey, crypto.randomBytes(32), wrapAad(employeeId)).toString('base64url');
    },
    unwrapKey: unwrap,
    /** Key rotation: the same employee key, wrapped under the current master key. */
    rewrapKey(employeeId: number, wrapped: string) {
      return gcm(masterKey, unwrap(employeeId, wrapped), wrapAad(employeeId)).toString('base64url');
    },
    seal(dataKey: Buffer, employeeId: number, field: string, value: string) {
      return SEALED_PREFIX + gcm(dataKey, Buffer.from(value, 'utf8'), aad(employeeId, field)).toString('base64url');
    },
    open(dataKey: Buffer, employeeId: number, field: string, sealed: string) {
      return ungcm(dataKey, Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url'), aad(employeeId, field)).toString('utf8');
    },
    /** Case, spaces and dashes do not matter: "2123-456 789" finds "2123456789". */
    blindIndex(category: PdplCategory, value: string) {
      return digest(pepper, category, value);
    },
    /** What a search looks for: the current digest, and during a pepper rotation the old one too. */
    searchDigests(category: PdplCategory, value: string) {
      return oldPepper ? [digest(pepper, category, value), digest(oldPepper, category, value)] : [digest(pepper, category, value)];
    },
  };
}

export type FieldCrypto = ReturnType<typeof createFieldCrypto>;

/** The configured keys, or (outside production) keys derived from the JWT secret. */
export function fieldCryptoFromEnv(env: {
  PDPL_FIELD_ENCRYPTION_KEY: string; PDPL_BLIND_INDEX_PEPPER: string; JWT_SECRET: string;
  PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS?: string; PDPL_BLIND_INDEX_PEPPER_PREVIOUS?: string;
}) {
  const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET, 'aigh-nurseapp', info, 32));
  return createFieldCrypto(
    env.PDPL_FIELD_ENCRYPTION_KEY ? Buffer.from(env.PDPL_FIELD_ENCRYPTION_KEY, 'base64') : derive('pdpl-field-dev'),
    env.PDPL_BLIND_INDEX_PEPPER ? Buffer.from(env.PDPL_BLIND_INDEX_PEPPER, 'base64') : derive('pdpl-pepper-dev'),
    { masterKey: previousKey(env.PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS), pepper: previousKey(env.PDPL_BLIND_INDEX_PEPPER_PREVIOUS) },
  );
}

/** Saudi national ID / Iqama pattern: 10 digits starting with 1 or 2. */
const ID_NUMBER = /(?<!\d)[12]\d{9}(?!\d)/g;
/** Log redaction (spec §8.3.4): masks anything shaped like a national ID or Iqama number. */
export const redactIdentifiers = (s: string) => s.replace(ID_NUMBER, '[REDACTED-ID]');
