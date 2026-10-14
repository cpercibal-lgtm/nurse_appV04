// Every workflow drawn in the Guidelines. Each one is checked against the code
// (docs/GUIDELINES_COVERAGE.md); a step the system does not do is not drawn.
// A decision is always the last node of its list; its branches carry on below it.

import type { Flow } from './types';

export const FLOWS: Flow[] = [
  {
    id: 'hospital-workflow',
    title: 'How the hospital system works',
    caption: 'Master data is set up once and kept current; each nurse then moves from contract to credentials to eligibility, and only eligible nurses reach the roster.',
    columns: 2,
    nodes: [
      { kind: 'group', label: 'HOSPITAL MASTER DATA' },
      { kind: 'step', label: 'Departments → Units → Beds', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Positions (schedulable or not)', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Credential catalogue (four-eyes)', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Credential requirements per unit and position', role: 'HR_ADMIN' },
      { kind: 'group', label: 'NURSE / EMPLOYEE' },
      { kind: 'step', label: 'Onboard the nurse (employee + Draft contract)', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Contract approved by a second HR administrator', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Credentials recorded with evidence', role: 'EMPLOYEE' },
      { kind: 'step', label: 'Verification by HR / SCFHS check', role: 'HR_ADMIN' },
      { kind: 'group', label: 'ELIGIBILITY' },
      { kind: 'state', label: 'Eligibility calculated for every change and every day', role: 'SYSTEM' },
      { kind: 'group', label: 'WORKFORCE AND ROSTER' },
      { kind: 'step', label: 'Coverage targets per unit and shift', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Supervisor drafts and publishes the roster', role: 'SUPERVISOR' },
      { kind: 'group', label: 'ON THE DAY' },
      { kind: 'step', label: 'Attendance from the badge system', role: 'SYSTEM' },
      { kind: 'step', label: 'Monitoring: KPI, gaps, reminders', role: 'SYSTEM' },
      { kind: 'step', label: 'Notifications to the people who act', role: 'SYSTEM' },
      { kind: 'end', label: 'Audit trail and governance (every step recorded)' },
    ],
  },
  {
    id: 'four-eyes',
    title: 'Approval by a second administrator (four-eyes)',
    caption: 'Protected changes wait in Nursing Administration → Approvals. The person who asked can withdraw the request but never approve it.',
    nodes: [
      { kind: 'start', label: 'An administrator submits a protected change with a reason', role: 'HR_ADMIN' },
      { kind: 'state', label: 'PENDING — nothing has changed yet', role: 'SYSTEM' },
      { kind: 'step', label: 'A different authorised administrator reviews it', role: 'HR_ADMIN' },
      {
        kind: 'decision', label: 'Decision (with a reason)', branches: [
          { label: 'Approve', nodes: [{ kind: 'state', label: 'Re-checked, then applied as the approver', role: 'SYSTEM' }, { kind: 'end', label: 'Change in force; audited' }] },
          { label: 'Reject', nodes: [{ kind: 'stop', label: 'Nothing changes; the reason is recorded' }] },
        ],
      },
    ],
  },
  {
    id: 'sign-in',
    title: 'Signing in',
    nodes: [
      { kind: 'start', label: 'Open the website; enter e-mail and password', role: 'EMPLOYEE' },
      { kind: 'step', label: 'Two-factor code (or set-up, if your role requires it)', role: 'EMPLOYEE' },
      { kind: 'state', label: 'The menu shows the pages your role can use', role: 'SYSTEM' },
      { kind: 'end', label: 'Sign out from the menu at the top right when you finish' },
    ],
  },
  {
    id: 'invitation',
    title: 'Account by invitation',
    caption: 'Needs e-mail switched on, an Approved or Active contract and a valid contact e-mail on the staff record.',
    nodes: [
      { kind: 'start', label: 'HR opens the nurse → Login account → Send invitation', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Private link e-mailed (valid 72 hours, works once)', role: 'SYSTEM' },
      { kind: 'step', label: 'The nurse opens the link, enters the Job Number, chooses a password', role: 'EMPLOYEE' },
      { kind: 'end', label: 'Account created and linked to the staff record' },
    ],
  },
  {
    id: 'onboarding',
    title: 'Onboarding a nurse',
    nodes: [
      { kind: 'start', label: 'Nurses → Onboard employee: details + contract dates', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Employee and Draft contract created together', role: 'SYSTEM' },
      { kind: 'state', label: 'Eligibility: INELIGIBLE (no approved contract yet)', role: 'SYSTEM' },
      { kind: 'step', label: 'Contracts: upload the signed copy, Submit', role: 'HR_ADMIN' },
      { kind: 'step', label: 'A different HR administrator approves', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Credentials recorded and verified', role: 'HR_ADMIN' },
      { kind: 'end', label: 'Eligible → can be scheduled in the home unit' },
    ],
  },
  {
    id: 'contract-lifecycle',
    title: 'Contract approval',
    caption: 'The creator and the submitter can never approve. Only Approved and Active contracts cover a date. A renewal needs valid credentials (the ended contract itself does not count); a first contract is not checked.',
    nodes: [
      { kind: 'start', label: 'New contract or Renew contract → Draft', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Renewal only: refused unless every required credential is valid (checked again at Approve)', role: 'SYSTEM' },
      { kind: 'step', label: 'Upload the signed copy (PDF, scanned clean)', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Submit → Pending approval', role: 'HR_ADMIN' },
      {
        kind: 'decision', label: 'A different HR administrator decides', branches: [
          { label: 'Approve', nodes: [{ kind: 'state', label: 'Active (covers today) or Approved (starts later)', role: 'SYSTEM' }, { kind: 'end', label: 'Eligibility re-evaluated at once' }] },
          { label: 'Return (reason)', nodes: [{ kind: 'stop', label: 'Back to Draft: correct and submit again' }] },
        ],
      },
    ],
  },
  {
    id: 'contract-dates',
    title: 'What happens to a contract by date',
    nodes: [
      { kind: 'state', label: 'Approved: start date reached → Active (daily job, 00:05)', role: 'SYSTEM' },
      { kind: 'state', label: 'Reminders at 90, 30, 14 and 7 days before the end', role: 'SYSTEM' },
      { kind: 'state', label: 'End date passed → Expired: no coverage', role: 'SYSTEM' },
      { kind: 'end', label: 'Nurse becomes INELIGIBLE unless a renewal was approved' },
    ],
  },
  {
    id: 'credential-new',
    title: 'Adding a credential',
    nodes: [
      { kind: 'start', label: 'My Credentials → Add credential (or HR: Records → Record credential for a nurse): type + details', role: 'EMPLOYEE' },
      { kind: 'step', label: 'Evidence → upload the document (scanned for viruses)', role: 'EMPLOYEE' },
      { kind: 'state', label: 'Pending verification — in the HR review queue', role: 'SYSTEM' },
      { kind: 'step', label: 'HR opens the evidence and clicks Verify', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Valid / Expiring soon / Expired, from the expiry date', role: 'SYSTEM' },
      { kind: 'end', label: 'Eligibility re-evaluated at once' },
    ],
  },
  {
    id: 'credential-renewal',
    title: 'Credential renewal',
    caption: 'The current credential stays usable until its own expiry while the renewal is reviewed.',
    nodes: [
      { kind: 'start', label: 'My Credentials → Renew (Valid, Expiring soon or Expired)', role: 'EMPLOYEE' },
      { kind: 'step', label: 'Enter the new details, including the new expiry date', role: 'EMPLOYEE' },
      { kind: 'step', label: 'Evidence → upload the new document', role: 'EMPLOYEE' },
      { kind: 'state', label: 'Renewal under review — in the HR review queue', role: 'SYSTEM' },
      { kind: 'step', label: 'HR reviews the staged details and the new evidence', role: 'HR_ADMIN' },
      {
        kind: 'decision', label: 'HR decides', branches: [
          { label: 'Approve renewal', nodes: [{ kind: 'state', label: 'New details and evidence take effect; any grace closes', role: 'SYSTEM' }, { kind: 'end', label: 'Eligibility re-evaluated' }] },
          { label: 'Reject (reason)', nodes: [{ kind: 'stop', label: 'Staged details cleared; the approved record is unchanged' }] },
        ],
      },
    ],
  },
  {
    id: 'credential-suspend',
    title: 'Suspending or revoking a credential',
    nodes: [
      { kind: 'start', label: 'Credentials → Records → Suspend or Revoke, with a reason', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Nurse INELIGIBLE for every unit that requires it — at once', role: 'SYSTEM' },
      { kind: 'state', label: 'Invalid future published shifts return to Draft; supervisors notified', role: 'SYSTEM' },
      { kind: 'end', label: 'Revoked is final. Lifting a suspension is not available in V04: record a new credential' },
    ],
  },
  {
    id: 'scfhs-check',
    title: 'SCFHS licence check',
    caption: 'For credential types set to "Check with SCFHS": on submission, nightly at 05:00, and on demand. SCFHS never overwrites the record.',
    nodes: [
      { kind: 'start', label: 'Credentials → SCFHS → Check with SCFHS now', role: 'HR_ADMIN' },
      { kind: 'state', label: 'SCFHS answers: Valid, Expired, Suspended, Revoked, Not found or Unreachable', role: 'SYSTEM' },
      {
        kind: 'decision', label: 'Compared with the record', branches: [
          { label: 'Matches', nodes: [{ kind: 'end', label: 'Nothing to do' }] },
          { label: 'Differs / not found', nodes: [{ kind: 'state', label: 'HR notified (or auto-suspended if the type says so)', role: 'SYSTEM' }, { kind: 'end', label: 'HR checks the evidence and corrects the record' }] },
          { label: 'Unreachable', nodes: [{ kind: 'stop', label: 'Logged; try again later' }] },
        ],
      },
    ],
  },
  {
    id: 'requirement',
    title: 'Configuring a credential requirement',
    nodes: [
      { kind: 'start', label: 'Credentials → Requirements → Add requirement', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Unit + position (blank = all) + credential type + policy', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Saved; every affected nurse re-evaluated at once', role: 'SYSTEM' },
      {
        kind: 'decision', label: 'Policy', branches: [
          { label: 'MANDATORY', nodes: [{ kind: 'end', label: 'Missing = INELIGIBLE' }] },
          { label: 'TRANSITION', nodes: [{ kind: 'end', label: 'Warning until the deadline, then blocks' }] },
          { label: 'OPTIONAL', nodes: [{ kind: 'end', label: 'Never affects eligibility' }] },
        ],
      },
    ],
  },
  {
    id: 'catalog-change',
    title: 'Changing the credential catalogue',
    nodes: [
      { kind: 'start', label: 'Catalog or Categories → Add / Edit, with a reason (10+ characters)', role: 'HR_ADMIN' },
      { kind: 'state', label: 'PENDING APPROVAL (before → after shown)', role: 'SYSTEM' },
      { kind: 'step', label: 'A different hospital-wide administrator: Approvals', role: 'HR_ADMIN' },
      {
        kind: 'decision', label: 'Decision', branches: [
          { label: 'Approve', nodes: [{ kind: 'end', label: 'Change applied (refused if the type changed meanwhile)' }] },
          { label: 'Reject', nodes: [{ kind: 'stop', label: 'Nothing changes' }] },
        ],
      },
    ],
  },
  {
    id: 'eligibility-engine',
    title: 'How eligibility is decided',
    caption: 'Checked in this order for the date asked about. The first failures block; everything is listed as a reason.',
    nodes: [
      { kind: 'step', label: '1. Employee exists, not deleted, status Active', role: 'SYSTEM' },
      { kind: 'step', label: '2. Position is schedulable', role: 'SYSTEM' },
      { kind: 'step', label: '3. An Approved or Active contract covers the date', role: 'SYSTEM' },
      { kind: 'step', label: '4. Employee has a unit (no requirements → allowed, with a note)', role: 'SYSTEM' },
      { kind: 'step', label: '5. Each required credential: verified, issued, not expired on the date', role: 'SYSTEM' },
      { kind: 'step', label: '6. If not: grace → waiver → transition deadline → else block', role: 'SYSTEM' },
      {
        kind: 'decision', label: 'Result', branches: [
          { label: 'Nothing blocks', nodes: [{ kind: 'end', label: 'ELIGIBLE' }] },
          { label: 'Grace used', nodes: [{ kind: 'end', label: 'ELIGIBLE WITH GRACE' }] },
          { label: 'Transition unmet', nodes: [{ kind: 'end', label: 'ELIGIBLE WITH POLICY WARNING' }] },
          { label: 'Anything blocks', nodes: [{ kind: 'stop', label: 'INELIGIBLE' }] },
        ],
      },
    ],
  },
  {
    id: 'ineligibility-resolution',
    title: 'Resolving an ineligible nurse',
    nodes: [
      { kind: 'start', label: 'Open Eligibility; filter Ineligible', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Select the nurse and read the red reasons', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Identify the root cause (contract, credential, unit, position)', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Correct the source record on its own page', role: 'HR_ADMIN' },
      { kind: 'state', label: 'Eligibility recalculated automatically', role: 'SYSTEM' },
      { kind: 'step', label: 'Check the new result on Eligibility', role: 'HR_ADMIN' },
      { kind: 'end', label: 'Return to Scheduling' },
    ],
  },
  {
    id: 'waiver',
    title: 'Emergency waiver',
    nodes: [
      { kind: 'start', label: 'Eligibility → Grant waiver on a blocked nurse', role: 'SUPERVISOR' },
      { kind: 'step', label: 'One blocking credential type, clinical justification, expiry ≤ 72 hours', role: 'SUPERVISOR' },
      { kind: 'state', label: 'Audited as high priority', role: 'SYSTEM' },
      { kind: 'state', label: 'That credential no longer blocks until the waiver expires', role: 'SYSTEM' },
      { kind: 'end', label: 'Fix the credential before the waiver ends' },
    ],
  },
  {
    id: 'roster',
    title: 'Building and publishing a roster',
    nodes: [
      { kind: 'start', label: 'Scheduling: select the unit and the week', role: 'SUPERVISOR' },
      { kind: 'step', label: 'Read each cell: eligible staff / target, shortage', role: 'SUPERVISOR' },
      { kind: 'step', label: '+ : pick from the eligible pool (live check for that date)', role: 'SUPERVISOR' },
      { kind: 'step', label: 'Or Auto-fill: preview, then create drafts', role: 'SUPERVISOR' },
      { kind: 'step', label: 'Resolve gaps and red (ineligible) drafts', role: 'SUPERVISOR' },
      { kind: 'step', label: 'Ask for approval (Supervisor or Nursing Admin)', role: 'SUPERVISOR' },
      { kind: 'step', label: 'The Nursing Director approves the week (a rejection gives a reason: change the drafts and ask again)', role: 'SUPERVISOR' },
      { kind: 'step', label: 'Publish week (changing a draft after approval withdraws it)', role: 'SUPERVISOR' },
      {
        kind: 'decision', label: 'Each draft re-checked', branches: [
          { label: 'Eligible', nodes: [{ kind: 'end', label: 'Published (visible to the nurse)' }] },
          { label: 'Ineligible', nodes: [{ kind: 'stop', label: 'Stays Draft, with the reasons' }] },
        ],
      },
    ],
  },
  {
    id: 'roster-revalidation',
    title: 'When a published shift becomes invalid',
    nodes: [
      { kind: 'start', label: 'A fact changes: contract, credential, unit, position, or a date passes', role: 'SYSTEM' },
      { kind: 'state', label: 'Future published shifts re-checked for their own dates', role: 'SYSTEM' },
      { kind: 'state', label: 'Invalid shifts return to Draft, audited high priority', role: 'SYSTEM' },
      { kind: 'state', label: 'Unit supervisors notified: "Published shift returned to draft"', role: 'SYSTEM' },
      { kind: 'end', label: 'Supervisor re-staffs the shift and publishes again' },
    ],
  },
  {
    id: 'attendance',
    title: 'Attendance and gaps',
    nodes: [
      { kind: 'start', label: 'Published shift', role: 'SYSTEM' },
      { kind: 'step', label: 'Clock-in arrives from the badge system', role: 'SYSTEM' },
      {
        kind: 'decision', label: 'Classified', branches: [
          { label: 'Clocked in', nodes: [{ kind: 'end', label: 'PRESENT (or ON DUTY BUT INELIGIBLE)' }] },
          { label: 'No clock-in', nodes: [{ kind: 'state', label: '30 minutes after start: MISSING', role: 'SYSTEM' }, { kind: 'end', label: 'Critical alert to unit supervisors (checked every 15 min)' }] },
        ],
      },
    ],
  },
  {
    id: 'reminders',
    title: 'Expiry reminders',
    nodes: [
      { kind: 'start', label: 'Daily scan at 06:00 (Riyadh)', role: 'SYSTEM' },
      { kind: 'state', label: 'Credential: 60, 30, 14, 7 days before, and after expiry', role: 'SYSTEM' },
      { kind: 'state', label: 'Contract: 90, 30, 14, 7 days before, and after the end', role: 'SYSTEM' },
      { kind: 'state', label: 'In-app notice (+ e-mail copy; + Telegram ping if linked)', role: 'SYSTEM' },
      { kind: 'end', label: 'The holder renews; HR or the supervisor follows up' },
    ],
  },
  {
    id: 'announcement',
    title: 'Sending an announcement',
    caption: 'Memos, meeting schedules and seminar notices (owner decisions 2026-10-05). Nothing is edited once sent: cancel it and send a new one.',
    nodes: [
      { kind: 'start', label: 'Announcements → New announcement: type, text, audience', role: 'SUPERVISOR' },
      { kind: 'step', label: 'Preview: who receives it, e-mail-only staff, delivery time', role: 'SUPERVISOR' },
      {
        kind: 'decision', label: 'Who is sending, to whom?', branches: [
          { label: 'A Supervisor, to their own units', nodes: [{ kind: 'end', label: 'Sent at once' }] },
          { label: 'An HR Admin or System Admin (any audience)', nodes: [{ kind: 'state', label: 'PENDING in Approvals: a second administrator approves', role: 'SYSTEM' }, { kind: 'end', label: 'Sent after approval' }] },
        ],
      },
    ],
  },
  {
    id: 'announcement-delivery',
    title: 'How an announcement reaches staff',
    nodes: [
      { kind: 'start', label: 'Announcement sent', role: 'SYSTEM' },
      { kind: 'state', label: 'Staff with an account: in-app notice and the Announcements board', role: 'SYSTEM' },
      { kind: 'state', label: 'E-mail copy with the full text (security e-mail first; at most EMAIL_HOURLY_LIMIT an hour)', role: 'SYSTEM' },
      { kind: 'state', label: 'Telegram, if linked: a short prompt only — never the content', role: 'SYSTEM' },
      { kind: 'state', label: 'Staff without an account: the e-mail only, at their contact address', role: 'SYSTEM' },
      { kind: 'end', label: 'Removed from the board after its date; kept in Archived' },
    ],
  },
  {
    id: 'role-grant',
    title: 'Granting a role',
    nodes: [
      { kind: 'start', label: 'Role assignments → Grant role: account, role, scope, reason (20+)', role: 'HR_ADMIN' },
      {
        kind: 'decision', label: 'Which role?', branches: [
          { label: 'Supervisor, or HR Admin for units / departments', nodes: [{ kind: 'end', label: 'Applied at once' }] },
          { label: 'System Admin, or HR Admin hospital-wide', nodes: [{ kind: 'state', label: 'PENDING: a second administrator approves', role: 'SYSTEM' }, { kind: 'end', label: 'Applied after approval' }] },
        ],
      },
    ],
  },
  {
    id: 'pam',
    title: 'System Admin elevation',
    nodes: [
      { kind: 'start', label: 'System Admin signs in: rights are dormant', role: 'SYSTEM_ADMIN' },
      { kind: 'step', label: 'Nursing Administration → Privileged access: reason + 1–4 hours', role: 'SYSTEM_ADMIN' },
      { kind: 'state', label: '"Elevated until …" shown; admin tabs and Audit available', role: 'SYSTEM' },
      { kind: 'end', label: 'End elevation when done (or it ends by itself)' },
    ],
  },
  {
    id: 'baseline-import',
    title: 'Hospital baseline import',
    nodes: [
      { kind: 'start', label: 'Choose the baseline file (JSON) → Preview', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Resolve conflicts and rejected rows on the normal screens', role: 'HR_ADMIN' },
      { kind: 'step', label: 'Request the import with a reason', role: 'HR_ADMIN' },
      { kind: 'state', label: 'PENDING: a second hospital-wide administrator approves', role: 'SYSTEM' },
      { kind: 'end', label: 'Applied in one step, or not at all' },
    ],
  },
  {
    id: 'pdpl-request',
    title: 'Personal-data request (PDPL)',
    nodes: [
      { kind: 'start', label: 'My data → New request (or HR logs one received on paper)', role: 'EMPLOYEE' },
      { kind: 'step', label: 'HR: Start review (answer due within 30 days)', role: 'HR_ADMIN' },
      {
        kind: 'decision', label: 'Request type', branches: [
          { label: 'Access / portability', nodes: [{ kind: 'end', label: 'Approve: package downloadable for 30 days' }] },
          { label: 'Correction', nodes: [{ kind: 'end', label: 'Approve, correct the record, Complete with a note' }] },
          { label: 'Erasure', nodes: [{ kind: 'end', label: 'A System Admin (not the logger) erases' }] },
        ],
      },
    ],
  },
  {
    id: 'password-reset',
    title: 'Forgotten password',
    caption: 'Staff accounts only. Supervisor, HR and administrator accounts: HR sends the reset link (valid 24 hours).',
    nodes: [
      { kind: 'start', label: 'Sign-in page → Forgot password?', role: 'EMPLOYEE' },
      { kind: 'state', label: 'Link e-mailed to the account address (30 minutes)', role: 'SYSTEM' },
      { kind: 'step', label: 'Open the link, choose a new password (12+ characters)', role: 'EMPLOYEE' },
      { kind: 'end', label: 'All sessions signed out; sign in again' },
    ],
  },
];

export const flowById = (id: string) => FLOWS.find((f) => f.id === id);
