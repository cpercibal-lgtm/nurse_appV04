// Nightly SCFHS licence check (spec §5.4, D-64). Daily at 05:00 Riyadh, before
// the 06:00 expiry scan: every current credential of an SCFHS-checked type is
// checked with SCFHS (the simulated registry while SCFHS_DRIVER=mock; none while off, D-75), and the
// answers acted on as in modules/credentials/scfhs.ts. Stops after
// MAX_CONSECUTIVE_ERRORS failures in a row (SCFHS unreachable).

import { loadEnv } from '../config/env.js';
import { fieldCryptoFromEnv } from '../lib/field-crypto.js';
import type { Db } from '../lib/prisma.js';
import { createScfhsGateway } from '../lib/scfhs.js';
import { createScfhsService } from '../modules/credentials/scfhs.js';
import { createProtection } from '../modules/pdpl/protection.js';

export async function scfhsSync(db: Db, now = new Date()) {
  const env = loadEnv();
  return createScfhsService(db, createScfhsGateway(env, db), createProtection(fieldCryptoFromEnv(env))).syncAll(now);
}
