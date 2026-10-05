// The permission table: which authorization roles may perform which operation
// (spec §8.1 matrix, docs/API.md "Permission" column). Default deny (R15):
// an operation not listed here cannot be authorized. EMPLOYEE is implicit for
// every active user and is never stored (R1); `EMPLOYEE` below means "any
// authenticated user", with record scope limited to their own data.
//
// Each later domain module adds its permissions here, so this file is the one
// place to read who can do what.

import type { AppRole } from '../../generated/prisma/client.js';

export type EffectiveRole = AppRole | 'EMPLOYEE';

export const PERMISSIONS = {
  // Accounts — spec §8.1 "Provision and administer within assigned scope".
  'accounts.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'accounts.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Role assignments and four-eyes approvals (R2–R12).
  'roles.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'roles.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'approvals.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'approvals.decide': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Hospital master-data import (P7): hospital-wide scope and four-eyes enforced in the service.
  'baseline.import': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Reference data every signed-in user may read.
  'matrix.read': ['EMPLOYEE'],
  'workforce.read': ['EMPLOYEE'], // departments, units, positions, coverage targets, bed summary (API.md §2.4)
  // Organisation structure is one hospital-wide configuration: the service
  // limits departments, unit create/move, positions and CSV import to
  // system-wide scope; bed counts and coverage targets follow unit scope.
  'workforce.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'workforce.bedHistory': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'kpi.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],

  // Employee master — spec §8.1 row: HR maintains within scope; Supervisor
  // assigned-unit view with private fields suppressed; Employee own profile.
  'employees.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'employees.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Rule E9: position assignment is HR_ADMIN only.
  'employees.position': ['HR_ADMIN'],
  // Owner decision 2026-10-05: unit and position together from the Nurses list (right-click); System Admin while elevated.
  'employees.assign': ['HR_ADMIN', 'SYSTEM_ADMIN'],

  // Contracts — spec §4.1: HR/System Admin scoped create, approval, renewal,
  // termination; Supervisor scoped reduced view; Employee own reduced view.
  'contracts.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'contracts.manage': ['HR_ADMIN', 'SYSTEM_ADMIN'],

  // Scheduling — spec §8.1: HR "coverage/read view by default"; scoped
  // Supervisor drafts and publishes (D-14). Employees read their own and
  // home-unit published schedule through /roster/me.
  'roster.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'roster.write': ['SUPERVISOR'],
  'attendance.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  // D-65: badge events are delivered by the badge system (an API client with the attendance.ingest scope), never by a person.
  'attendance.ingest': [],

  // Audit (D-20: System Admin only until decided) and background jobs.
  'audit.read': ['SYSTEM_ADMIN'],
  // PDPL (spec §8.3.2, D-54): the processing register — HR and System Admins read, System Admins maintain.
  'pdpl.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'pdpl.manage': ['SYSTEM_ADMIN'],
  // B-18 (D-56): the Data Protection Officer's periodic sign-off of the register, from an HR or System Admin account.
  'pdpl.signoff': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // Data-subject requests (spec §8.3.3, D-55): HR works the queue within scope; only a System Admin approves an erasure.
  'pdpl.requests': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'pdpl.erase': ['SYSTEM_ADMIN'],
  // FHIR R4 read API (spec §14.1, D-61): Practitioner / PractitionerRole within the caller's scope.
  'fhir.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  // FHIR API clients (D-63): the systems that may call the FHIR API without a person signed in.
  'apiclients.manage': ['SYSTEM_ADMIN'],
  'jobs.read': ['SYSTEM_ADMIN'],
  // Dev Console (D-66): the messages the mock Telegram gateway intercepted, and a test message for demonstrations.
  'devconsole.telegram.read': ['SYSTEM_ADMIN'],
  'devconsole.telegram.send': ['SYSTEM_ADMIN'],
  // Dev Console (D-64): the simulated SCFHS registry the mock SCFHS gateway answers from.
  'devconsole.scfhs.read': ['SYSTEM_ADMIN'],
  'devconsole.scfhs.manage': ['SYSTEM_ADMIN'],
  // Dev Console (D-65): the badge simulator — clock events as if from the badge system, for demonstrations.
  'devconsole.badge.read': ['SYSTEM_ADMIN'],
  'devconsole.badge.write': ['SYSTEM_ADMIN'],
  'jobs.run': ['SYSTEM_ADMIN'],

  // Credentials and eligibility — spec §8.1 Credentials row, §5.1.4, §6.1.
  'credentials.catalog.read': ['EMPLOYEE'],
  'credentials.catalog.write': ['HR_ADMIN', 'SYSTEM_ADMIN'], // system-wide scope enforced in the service
  'requirements.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  'requirements.write': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'credentials.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'], // supervisors get the compliance view
  'credentials.manage': ['HR_ADMIN', 'SYSTEM_ADMIN'], // record, verify, suspend, revoke, renewal decisions
  'credentials.self': ['EMPLOYEE'], // own submission, evidence, alerts
  'eligibility.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  // Shadow mode (spec §10.9, D-60): new eligibility logic runs beside the active one; HR decides
  // each disagreement and promotes it (system-wide scope, enforced in the service).
  'eligibility.logic.read': ['HR_ADMIN', 'SYSTEM_ADMIN'],
  'eligibility.logic.review': ['HR_ADMIN'],
  'eligibility.logic.promote': ['HR_ADMIN'],
  'waivers.read': ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'],
  // Spec §6.1.2: "only users with the Supervisor or HR_Admin role can issue a waiver".
  'waivers.write': ['SUPERVISOR', 'HR_ADMIN'],
} as const satisfies Record<string, readonly EffectiveRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Spec §8.1 table, served read-only by GET /roles/matrix. */
export const ACCESS_MATRIX = {
  columns: ['HR Admin / System Admin', 'Supervisor / Scheduler', 'Employee'],
  rows: [
    { area: 'Accounts', cells: ['Provision and administer within assigned scope', 'No account administration by default', 'Claim invited account; own password'] },
    { area: 'Employee Master', cells: ['Maintain source fields within scope', 'Assigned-unit baseline/compliance view; private fields suppressed', 'Own profile; phone update'] },
    { area: 'Contracts', cells: ['Scoped create, approval, renewal, termination', 'Scoped reduced read view', 'Own reduced read view'] },
    { area: 'Credentials', cells: ['Scoped upload, review, validity decisions', 'Scoped compliance view; no evidence downloads', 'Own submission, evidence, alerts'] },
    { area: 'Scheduling', cells: ['Coverage/read view by default', 'Scoped draft and publish', 'Published personal/home-unit view'] },
    { area: 'Notifications', cells: ['Own recipient rows', 'Own recipient rows', 'Own recipient rows'] },
  ],
  source: 'Specification §8.1',
} as const;
