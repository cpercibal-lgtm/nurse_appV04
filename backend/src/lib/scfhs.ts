// SCFHS licence verification behind one interface (spec §5.4, D-64).
//
// The live SCFHS verification service needs an agreement with the Saudi
// Commission for Health Specialties (decision gate U3), which does not exist
// yet. Until then, outside production (and on a demonstration server that sets
// SCFHS_DRIVER=mock) lookups are answered from
// mock_scfhs_registry, a simulated registry a System Admin edits in the Dev
// Console (Nursing Administration → SCFHS registry) to demonstrate every
// outcome — valid, expired, suspended, revoked, not found, and an outage.
// In production SCFHS_DRIVER defaults to off (D-75): nothing is checked, and HR
// records website observations by hand (D-74).
// Callers depend only on ScfhsGateway; createScfhsGateway picks the driver.
//
// lookup() answers what SCFHS says, or throws ScfhsUnavailableError when the
// service cannot be reached; the caller records the attempt either way.

import crypto from 'node:crypto';
import type { Env } from '../config/env.js';
import type { DbClient } from './prisma.js';

export type ScfhsDriver = NonNullable<Env['SCFHS_DRIVER']>;

/** SCFHS_DRIVER, or when unset: off in production — the simulated registry would answer "not found"
 *  for every real licence and flood HR with notices — and mock elsewhere (D-75; like BADGE_SIMULATOR, D-65). */
export const scfhsDriverOf = (env: Pick<Env, 'SCFHS_DRIVER' | 'NODE_ENV'>): ScfhsDriver =>
  env.SCFHS_DRIVER ?? (env.NODE_ENV === 'production' ? 'off' : 'mock');
export const SCFHS_STATUSES = ['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'NOT_FOUND'] as const;
export type ScfhsStatus = (typeof SCFHS_STATUSES)[number];

export interface ScfhsLookup {
  status: ScfhsStatus;
  /** YYYY-MM-DD, as SCFHS records it. */
  expiryDate: string | null;
  specialty: string | null;
  /** SCFHS's own wording of the status. */
  licenseStatus: string | null;
  /** SHA-256 of the raw response: evidence of what was answered, without keeping it. */
  responseHash: string;
}

export class ScfhsUnavailableError extends Error {}

export interface ScfhsGateway {
  readonly driver: ScfhsDriver;
  lookup(registrationNumber: string): Promise<ScfhsLookup>;
}

/** Registration numbers as SCFHS writes them: letters, digits and hyphens. */
export const SCFHS_REG = /^[A-Za-z0-9-]{3,40}$/;
export const normalizeReg = (reg: string) => reg.trim().toUpperCase();
/** Logs and notices show only the last four characters (the number is personal data, D-54). */
export const maskReg = (reg: string) => (reg.length > 4 ? `…${reg.slice(-4)}` : '…');

const hash = (body: unknown) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** Answers from the simulated registry. An entry with status ERROR simulates an outage. */
export class MockScfhsGateway implements ScfhsGateway {
  readonly driver = 'mock' as const;

  constructor(private readonly db: DbClient) {}

  async lookup(registrationNumber: string): Promise<ScfhsLookup> {
    const reg = normalizeReg(registrationNumber);
    const row = await this.db.mockScfhsRegistry.findUnique({ where: { registrationNumber: reg } });
    if (!row) return { status: 'NOT_FOUND', expiryDate: null, specialty: null, licenseStatus: null, responseHash: hash({ reg, found: false }) };
    if (row.status === 'ERROR') throw new ScfhsUnavailableError('Simulated SCFHS outage (registry entry set to ERROR)');
    const body = { reg, status: row.status, expiryDate: row.expiryDate, specialty: row.specialty, updatedAt: row.updatedAt };
    return {
      status: row.status as ScfhsStatus, expiryDate: row.expiryDate, specialty: row.specialty,
      licenseStatus: row.status === 'VERIFIED' ? 'Active' : row.status.charAt(0) + row.status.slice(1).toLowerCase(),
      responseHash: hash(body),
    };
  }
}

/** The SCFHS verification API. Not built until the SCFHS agreement (U3) gives its contract. */
export class LiveScfhsGateway implements ScfhsGateway {
  readonly driver = 'live' as const;

  constructor(private readonly config: { url: string; apiKey: string }) {}

  async lookup(_registrationNumber: string): Promise<ScfhsLookup> {
    // TODO: Implement the SCFHS verification API call here (HTTPS / mTLS, spec §5.4),
    // mapping its response to ScfhsLookup; throw ScfhsUnavailableError on a transport failure.
    void this.config;
    throw new ScfhsUnavailableError('The live SCFHS gateway is not implemented yet (needs the SCFHS agreement, U3)');
  }
}

/** SCFHS_DRIVER=off: no licence is checked. The service skips before calling lookup. */
export class OffScfhsGateway implements ScfhsGateway {
  readonly driver = 'off' as const;

  async lookup(_registrationNumber: string): Promise<ScfhsLookup> {
    throw new ScfhsUnavailableError('SCFHS checks are off (SCFHS_DRIVER=off)');
  }
}

export function createScfhsGateway(env: Pick<Env, 'SCFHS_DRIVER' | 'NODE_ENV' | 'SCFHS_API_URL' | 'SCFHS_API_KEY'>, db: DbClient): ScfhsGateway {
  const driver = scfhsDriverOf(env);
  if (driver === 'live') return new LiveScfhsGateway({ url: env.SCFHS_API_URL, apiKey: env.SCFHS_API_KEY });
  return driver === 'off' ? new OffScfhsGateway() : new MockScfhsGateway(db);
}
