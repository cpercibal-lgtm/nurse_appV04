// Credential types by nationality (owner decision 2026-10-04). A credential type applies to
// every nationality (ALL), ONLY to the listed ones, or to all EXCEPT them — e.g. Passport and
// Iqama EXCEPT Saudi, National ID ONLY Saudi. For an employee a type does not apply to, a
// requirement of that type counts as OPTIONAL: it can still be recorded and verified but never
// makes the employee ineligible. An employee without a listed nationality matches no code, so
// an EXCEPT type applies to them and an ONLY type does not.

import { z } from 'zod';
import { HttpError } from '../../lib/http-errors.js';
import type { DbClient } from '../../lib/prisma.js';

export const NATIONALITY_RULES = ['ALL', 'ONLY', 'EXCEPT'] as const;
export type NationalityRule = (typeof NATIONALITY_RULES)[number];

export const NationalityRuleSchema = z.enum(NATIONALITY_RULES);
/** Listed nationality codes (ISO 3166-1 alpha-3), sorted and without repeats so stored values compare exactly. */
export const NationalityCodesSchema = z.array(z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{3}$/, 'A nationality code has three letters')))
  .max(250).transform((codes) => [...new Set(codes)].sort());

/** Whether a credential type applies to an employee of this nationality. */
export function appliesToNationality(rule: NationalityRule, codes: readonly string[], nationalityCode: string | null): boolean {
  if (rule === 'ALL') return true;
  const listed = nationalityCode !== null && codes.includes(nationalityCode);
  return rule === 'ONLY' ? listed : !listed;
}

/** ALL lists nobody; ONLY and EXCEPT list at least one nationality, each on the nationality list. */
export async function assertNationalityRule(tx: DbClient, rule: NationalityRule, codes: readonly string[]) {
  if (rule === 'ALL' && codes.length > 0) throw new HttpError(422, 'NATIONALITY_RULE_INVALID', 'A credential type for every nationality lists no nationalities');
  if (rule !== 'ALL' && codes.length === 0) throw new HttpError(422, 'NATIONALITY_RULE_INVALID', 'Choose at least one nationality');
  if (codes.length === 0) return;
  const found = await tx.nationality.findMany({ where: { code: { in: [...codes] } }, select: { code: true } });
  const unknown = codes.filter((c) => !found.some((f) => f.code === c));
  if (unknown.length) throw new HttpError(422, 'NATIONALITY_INVALID', `Not a listed nationality: ${unknown.join(', ')}`);
}
