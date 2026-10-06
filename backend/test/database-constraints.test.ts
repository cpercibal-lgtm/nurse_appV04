// Database-level business rules (rule IDs: docs/FEATURE_MASTER_INVENTORY.md §15).
// Runs against the migrated database in TEST_DATABASE_URL; every case runs in a
// transaction that is rolled back, so the database is left unchanged.

import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, type Db, Prisma, withUtcSession } from '../src/lib/prisma.js';
import { appendAudit, findChainBreaks } from '../src/lib/audit.js';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

class Rollback extends Error {}

describeDb('database constraints', () => {
  let db: Db;

  beforeAll(() => { db = createPrisma(url!); });
  afterAll(async () => { await db.$disconnect(); });

  /** Runs `fn` in a transaction and always rolls it back. */
  async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
    await expect(db.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }))
      .rejects.toBeInstanceOf(Rollback);
  }

  async function fixture(tx: Prisma.TransactionClient) {
    const dept = await tx.department.create({ data: { code: `T${Date.now()}`, name: 'Test dept' } });
    const unit = await tx.unit.create({ data: { code: `TU${Date.now()}`, name: 'Test unit', departmentId: dept.id, bedCount: 10 } });
    await tx.position.upsert({ where: { code: 'SN' }, update: {}, create: { code: 'SN', title: 'Staff Nurse', tier: 'Clinical', isSchedulable: true } });
    const emp = await tx.employee.create({
      data: { jobNumber: `J${Date.now()}`, firstName: 'Test', lastName: 'Nurse', fullName: 'x', contactEmail: 't@x.sa', positionCode: 'SN', unitId: unit.id },
    });
    return { dept, unit, emp };
  }

  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it('credential fields: one row per key, valid keys, date flags only on dates, one issue and one expiry field (P1)', async () => {
    const code = (s: string) => `F${Date.now()}${s}`;
    const base = { ordinal: 0, label: 'L', type: 'text' as const, required: true };
    const violates = async (make: (tx: Prisma.TransactionClient, templateId: number) => Promise<unknown>) => inRollback(async (tx) => {
      await tx.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } });
      const t = await tx.credentialTemplate.create({ data: { code: code('T'), name: 'T', categoryCode: 'LICENSURE' } });
      await expect(make(tx, t.id)).rejects.toThrow();
    });
    await violates((tx, templateId) => tx.credentialTemplateField.createMany({ data: [{ ...base, templateId, key: 'a' }, { ...base, templateId, key: 'a', ordinal: 1 }] }));
    await violates((tx, templateId) => tx.credentialTemplateField.create({ data: { ...base, templateId, key: 'Bad Key' } }));
    await violates((tx, templateId) => tx.credentialTemplateField.create({ data: { ...base, templateId, key: 'x', isExpiryDate: true } }));
    await violates((tx, templateId) => tx.credentialTemplateField.createMany({ data: [
      { ...base, templateId, key: 'e1', type: 'date', isExpiryDate: true }, { ...base, templateId, key: 'e2', ordinal: 1, type: 'date_hijri', isExpiryDate: true },
    ] }));
    // One field cannot be both dates: the credential would expire the day it was issued.
    await violates((tx, templateId) => tx.credentialTemplateField.create({ data: { ...base, templateId, key: 'both', type: 'date', isIssueDate: true, isExpiryDate: true } }));
  });

  it('D-69 announcements: event times, https link, audience, priority, publication and cancellation fields', async () => {
    const valid = (createdById: number) => ({
      kind: 'MEMO' as const, title: 'Staff memo', body: 'Text', audienceType: 'HOSPITAL' as const,
      expiresAt: day('2026-12-31'), createdById,
    });
    /** Each case in its own rolled-back transaction: a failed statement ends the transaction. */
    const rejects = (patch: Record<string, unknown>, constraint: string) => inRollback(async (tx) => {
      const u = await tx.user.create({ data: { email: `ann${Date.now()}${Math.random()}@t.sa`, displayName: 'A', passwordHash: 'x' } });
      await expect(tx.announcement.create({ data: { ...valid(u.id), ...patch } as Prisma.AnnouncementUncheckedCreateInput })).rejects.toThrow(new RegExp(constraint));
    });
    await rejects({ kind: 'MEETING' }, 'chk_announcements_event_time');
    await rejects({ kind: 'SEMINAR', startsAt: day('2026-11-02'), endsAt: day('2026-11-01') }, 'chk_announcements_end_after_start');
    await rejects({ onlineUrl: 'http://meet.example/x' }, 'chk_announcements_online_url');
    await rejects({ onlineUrl: 'https://meet.example/a b' }, 'chk_announcements_online_url');
    await rejects({ title: '   ' }, 'chk_announcements_text');
    await rejects({ ceHours: 2 }, 'chk_announcements_ce_hours'); // a memo has no CE hours
    await rejects({ priority: 'CRITICAL' }, 'chk_announcements_priority');
    await rejects({ audienceIds: [1] }, 'chk_announcements_audience'); // hospital-wide names no ids
    await rejects({ audienceType: 'UNIT' }, 'chk_announcements_audience'); // a unit audience names one
    await rejects({ status: 'PUBLISHED' }, 'chk_announcements_published'); // no publication time or counts
    await rejects({ publishedAt: day('2026-10-05'), recipientCount: 1, emailOnlyCount: 0 }, 'chk_announcements_published'); // a draft is not published
    await rejects({ status: 'CANCELLED', publishedAt: day('2026-10-05'), recipientCount: 1, emailOnlyCount: 0, cancelledAt: day('2026-10-06') }, 'chk_announcements_cancelled'); // no reason

    await inRollback(async (tx) => {
      const u = await tx.user.create({ data: { email: `ann${Date.now()}@t.sa`, displayName: 'A', passwordHash: 'x' } });
      // The valid shapes are accepted: a seminar with times, link and CE hours; a published, then cancelled memo.
      await tx.announcement.create({ data: { ...valid(u.id), kind: 'SEMINAR', priority: 'MEDIUM', startsAt: day('2026-11-01'), endsAt: day('2026-11-02'), onlineUrl: 'https://meet.example/x', ceHours: 1.5, audienceType: 'UNIT', audienceIds: [1] } });
      const a = await tx.announcement.create({ data: { ...valid(u.id), status: 'PUBLISHED', publishedAt: day('2026-10-05'), recipientCount: 1, emailOnlyCount: 0 } });
      await tx.announcement.update({ where: { id: a.id }, data: { status: 'CANCELLED', cancelledAt: day('2026-10-06'), cancelledById: u.id, cancelReason: 'Meeting moved' } });
      // A notification links to an announcement exactly when it is one.
      await tx.notification.create({ data: { recipientId: u.id, type: 'ANNOUNCEMENT', title: 't', message: 'm', announcementId: a.id } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.notification.create({ data: { recipientId: u.id, type: 'ANNOUNCEMENT', title: 't', message: 'm' } })).rejects.toThrow(/chk_notifications_announcement/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await expect(tx.notification.create({ data: { recipientId: u.id, type: 'SYSTEM', title: 't', message: 'm', announcementId: a.id } })).rejects.toThrow(/chk_notifications_announcement/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      // A sent announcement is never deleted out from under its notifications.
      await expect(tx.announcement.delete({ where: { id: a.id } })).rejects.toThrow();
    });
  });

  it('a deprecated position names an existing, different successor (P1)', async () => {
    const pos = { title: 'P', tier: 'Clinical', isSchedulable: true };
    await inRollback(async (tx) => {
      await expect(tx.position.create({ data: { ...pos, code: `Q${Date.now()}`, replacedBy: 'NO_SUCH_POSITION' } })).rejects.toThrow();
    });
    await inRollback(async (tx) => {
      const c = `S${Date.now()}`;
      await tx.position.create({ data: { ...pos, code: c } });
      await expect(tx.position.update({ where: { code: c }, data: { replacedBy: c } })).rejects.toThrow();
    });
  });

  it('C4: rejects overlapping Approved/Active contracts, allows an overlapping Draft', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      const base = { employeeId: emp.id, jobNumber: emp.jobNumber };
      await tx.contract.create({ data: { ...base, status: 'Active', startDate: day('2026-01-01'), endDate: day('2026-12-31') } });
      await tx.contract.create({ data: { ...base, status: 'Draft', startDate: day('2026-06-01'), endDate: day('2027-05-31') } });
      await expect(tx.$executeRaw`SAVEPOINT s1`).resolves.toBeDefined();
      await expect(tx.contract.create({ data: { ...base, status: 'Approved', startDate: day('2026-12-31'), endDate: day('2027-12-30') } }))
        .rejects.toThrow(/no_overlapping_active_contracts|exclusion|conflicting key/i);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      // Inclusive dates: the next period may start the day after the previous end.
      await tx.contract.create({ data: { ...base, status: 'Approved', startDate: day('2027-01-01'), endDate: day('2027-12-31') } });
    });
  });

  it('C5: rejects a contract whose end is not after its start', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      await expect(tx.contract.create({ data: { employeeId: emp.id, jobNumber: emp.jobNumber, startDate: day('2026-01-01'), endDate: day('2026-01-01') } }))
        .rejects.toThrow(/chk_contracts_dates|check constraint/i);
    });
  });

  it('E1: job numbers are unique case-insensitively and have no format rule', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      await tx.employee.create({ data: { jobNumber: 'AIGH1002', firstName: 'A', lastName: 'B', fullName: 'x', contactEmail: 'a@x.sa', positionCode: 'SN' } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.employee.create({ data: { jobNumber: emp.jobNumber.toLowerCase(), firstName: 'C', lastName: 'D', fullName: 'x', contactEmail: 'c@x.sa', positionCode: 'SN' } }))
        .rejects.toThrow(/unique|employees_job_number/i);
    });
  });

  it('E3: full name is derived from first + middle + last, ignoring the supplied value', async () => {
    await inRollback(async (tx) => {
      await fixture(tx); // ensures position SN exists
      const e = await tx.employee.create({ data: { jobNumber: 'FN1', firstName: ' Fatima ', lastName: 'Zahra', fullName: 'WRONG', contactEmail: 'f@x.sa', positionCode: 'SN' } });
      expect(e.fullName).toBe('Fatima Zahra');
      const u = await tx.employee.update({ where: { id: e.id }, data: { middleName: 'Al' } });
      expect(u.fullName).toBe('Fatima Al Zahra');
    });
  });

  it('W4: bed count must be 0–500', async () => {
    await inRollback(async (tx) => {
      const { unit } = await fixture(tx);
      await expect(tx.unit.update({ where: { id: unit.id }, data: { bedCount: 501 } })).rejects.toThrow(/chk_units_bed_count|check constraint/i);
    });
  });

  it('L9: waivers are limited to 72 hours and must expire in the future', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      const tpl = await tx.credentialTemplate.create({ data: { code: `TT${Date.now()}`, name: 'T', categoryCode: (await tx.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } })).code } });
      const user = await tx.user.create({ data: { email: `w${Date.now()}@x.sa`, displayName: 'W', passwordHash: 'x' } });
      const base = { employeeId: emp.id, templateId: tpl.id, waivedById: user.id, reason: 'staffing emergency', createdAt: new Date('2026-09-23T00:00:00Z') };
      await tx.credentialWaiver.create({ data: { ...base, expiresAt: new Date('2026-09-26T00:00:00Z') } }); // exactly 72 h
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.credentialWaiver.create({ data: { ...base, expiresAt: new Date('2026-09-26T00:00:01Z') } }))
        .rejects.toThrow(/chk_waiver_max_window|check constraint/i);
    });
  });

  it('S1: a nurse cannot hold the same shift twice on one date, even in two units', async () => {
    await inRollback(async (tx) => {
      const { emp, unit, dept } = await fixture(tx);
      const unit2 = await tx.unit.create({ data: { code: `TU2${Date.now()}`, name: 'Second', departmentId: dept.id } });
      const slot = { employeeId: emp.id, shiftDate: day('2026-10-01'), shiftType: 'Night' as const };
      const first = await tx.shiftAssignment.create({ data: { ...slot, unitId: unit.id } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.shiftAssignment.create({ data: { ...slot, unitId: unit2.id } })).rejects.toThrow(/unique|shift_assignments_employee_slot/i);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      // A cancelled assignment frees the slot.
      await tx.shiftAssignment.update({ where: { id: first.id }, data: { status: 'Cancelled' } });
      await tx.shiftAssignment.create({ data: { ...slot, unitId: unit2.id } });
    });
  });

  it('R3/R7: SYSTEM scope has no ids, and one active assignment per user + role + scope type', async () => {
    await inRollback(async (tx) => {
      const u = await tx.user.create({ data: { email: `r${Date.now()}@x.sa`, displayName: 'R', passwordHash: 'x' } });
      const base = { userId: u.id, grantedById: u.id, reason: 'test grant with a long reason' };
      await expect(tx.roleAssignment.create({ data: { ...base, role: 'HR_ADMIN', scopeType: 'SYSTEM', scopeIds: [1] } }))
        .rejects.toThrow(/chk_role_assignments_scope|check constraint/i);
    });
    await inRollback(async (tx) => {
      const u = await tx.user.create({ data: { email: `r2${Date.now()}@x.sa`, displayName: 'R', passwordHash: 'x' } });
      const base = { userId: u.id, grantedById: u.id, reason: 'test grant with a long reason', role: 'SUPERVISOR' as const, scopeType: 'UNIT' as const };
      const first = await tx.roleAssignment.create({ data: { ...base, scopeIds: [1] } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.roleAssignment.create({ data: { ...base, scopeIds: [2] } })).rejects.toThrow(/unique|role_assignments_active/i);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await tx.roleAssignment.update({ where: { id: first.id }, data: { revokedAt: new Date(), revokedById: u.id } });
      await tx.roleAssignment.create({ data: { ...base, scopeIds: [2] } });
    });
  });

  it('A2/A3: audit rows chain, verify, and cannot be updated or deleted', async () => {
    await inRollback(async (tx) => {
      const a = await appendAudit(tx, { actorUserId: null, action: 'TEST_A', resource: 'test', changes: { n: 1 } });
      const b = await appendAudit(tx, { actorUserId: null, action: 'TEST_B', resource: 'test', priority: 'HIGH' });
      const rows = await tx.auditEntry.findMany({ where: { id: { in: [a, b] } }, orderBy: { id: 'asc' } });
      expect(rows[1]!.previousHash).toBe(rows[0]!.hash);
      expect(await findChainBreaks(tx)).toEqual([]);
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.$executeRaw`UPDATE audit_entries SET action = 'TAMPERED' WHERE id = ${a}`).rejects.toThrow(/append-only/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await expect(tx.$executeRaw`DELETE FROM audit_entries WHERE id = ${a}`).rejects.toThrow(/append-only/);
    });
  });

  it('stores the exact instant Prisma writes, even when the connection asks for Asia/Riyadh', async () => {
    // Regression: Prisma 7.10's pg adapter sends Dates without an offset, so a
    // non-UTC session stored every timestamp 3 hours early (see lib/prisma.ts).
    const riyadh = createPrisma(`${url!}${url!.includes('?') ? '&' : '?'}options=-c%20TimeZone%3DAsia%2FRiyadh`);
    try {
      expect(await riyadh.$queryRaw`SHOW timezone`).toEqual([{ TimeZone: 'UTC' }]);
      await riyadh.$transaction(async (tx) => {
        const written = new Date('2026-01-01T12:00:00.000Z');
        const u = await tx.user.create({ data: { email: `tz${Date.now()}@x.sa`, displayName: 'tz', passwordHash: 'x', lastLoginAt: written } });
        const [row] = await tx.$queryRaw<Array<{ epoch: string; drift: string }>>`
          SELECT extract(epoch FROM last_login_at)::text AS epoch,
                 abs(extract(epoch FROM (created_at - now())))::text AS drift
          FROM users WHERE id = ${u.id}`;
        expect(Number(row!.epoch) * 1000).toBe(written.getTime());
        // A Prisma-generated default and the database clock agree (was 10800 s apart).
        expect(Number(row!.drift)).toBeLessThan(60);
        throw new Rollback();
      }).catch((e: unknown) => { if (!(e instanceof Rollback)) throw e; });
    } finally {
      await riyadh.$disconnect();
    }
  });

  it('keeps operator connection options when pinning UTC', () => {
    const u = new URL(withUtcSession('postgresql://a@h:5432/db?options=-c%20search_path%3Dx&sslmode=require'));
    expect(u.searchParams.get('options')).toBe('-c search_path=x -c TimeZone=UTC');
    expect(u.searchParams.get('sslmode')).toBe('require');
  });

  it('A3: the verification view detects a tampered row', async () => {
    await inRollback(async (tx) => {
      const id = await appendAudit(tx, { actorUserId: null, action: 'TEST_TAMPER', resource: 'test' });
      // Simulate tampering by a privileged actor who disables the guard trigger.
      await tx.$executeRaw`ALTER TABLE audit_entries DISABLE TRIGGER trg_audit_entries_append_only`;
      await tx.$executeRaw`UPDATE audit_entries SET changes = '{"forged":true}' WHERE id = ${id}`;
      expect(await findChainBreaks(tx)).toContainEqual({ id, reason: 'CONTENT_MISMATCH' });
    });
  });
});
