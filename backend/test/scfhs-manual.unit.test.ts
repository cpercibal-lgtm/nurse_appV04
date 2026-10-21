// Database unavailable locally: exercise the service with a transaction-boundary
// test double; the HTTP/database suite in scfhs.test.ts checks persistence and RBAC.
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/lib/prisma.js';
import type { AuthContext } from '../src/modules/users/access.js';
import type { Protection } from '../src/modules/pdpl/protection.js';
import { createScfhsService } from '../src/modules/credentials/scfhs.js';

const auth = { user: { id: 7 }, effective: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] } as AuthContext;
const body = { status: 'REVOKED' as const, checkedAt: '2026-01-01T10:00:00.000Z', notes: 'Checked the official website', evidenceDocumentId: 9 };
function fixture() {
  const lookup = vi.fn(() => { throw new Error('Manual checks must never call a gateway'); });
  const create = vi.fn(async ({ data }) => ({ id: 12n, ...data }));
  const audit = vi.fn(async () => [{ id: 1n }]);
  const tx = {
    credential: { findUnique: vi.fn(async () => ({ id: 3, employeeId: 4, template: { scfhsEnabled: true } })) },
    employee: { findFirst: vi.fn(async () => ({ unitId: 2 })) },
    documentVersion: { findFirst: vi.fn(async () => ({ id: 9, scanStatus: 'CLEAN', erasedAt: null })) },
    scfhsCheck: { create }, $queryRaw: audit,
  };
  const db = { $transaction: async (fn: (client: unknown) => unknown) => fn(tx) } as unknown as Db;
  return { service: createScfhsService(db, { driver: 'mock', lookup }, {} as Protection), tx, lookup, create, audit };
}
describe('recording an SCFHS website check', () => {
  it('records observation and audit in one transaction without a gateway, status write or eligibility refresh', async () => {
    const f = fixture();
    const out = await f.service.recordWebsiteCheck(auth, 3, body, 'req-1');
    expect(out).toMatchObject({ id: '12', driver: 'manual', responseStatus: 'REVOKED', action: 'NONE', actorUserId: 7, evidenceDocumentId: 9 });
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.audit).toHaveBeenCalledOnce();
    // This transaction double has no status-update, notification or eligibility
    // methods: any accidental call fails the test instead of being swallowed.
  });
  it('rejects evidence belonging to another credential before any write', async () => {
    const f = fixture();
    f.tx.documentVersion.findFirst.mockResolvedValueOnce(null as never);
    await expect(f.service.recordWebsiteCheck(auth, 3, body)).rejects.toMatchObject({ code: 'SCFHS_EVIDENCE_INVALID' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
  });
  it('rejects a future check time', async () => {
    const f = fixture();
    await expect(f.service.recordWebsiteCheck(auth, 3, { ...body, checkedAt: '2999-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'SCFHS_CHECK_IN_FUTURE' });
    expect(f.create).not.toHaveBeenCalled();
  });
});
