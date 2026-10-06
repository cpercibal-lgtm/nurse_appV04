// The Guidelines, in reading order. Numbering is derived, so inserting a section renumbers the rest.

import { FLOWS, flowById } from './flows';
import { ADMIN } from './sections/admin';
import { CREDENTIALS } from './sections/credentials';
import { OPERATIONS } from './sections/operations';
import { OVERVIEW } from './sections/overview';
import { PEOPLE } from './sections/people';
import { SELF } from './sections/self';
import { START } from './sections/start';
import type { GuideSection, GuideTask } from './types';

const byId = <T extends { id: string }>(list: T[], id: string) => list.find((x) => x.id === id)!;
const all = [...START, ...PEOPLE, ...CREDENTIALS, ...OPERATIONS, ...ADMIN, ...SELF, ...OVERVIEW];

/** Reading order (the brief's structure, with roles and approvals right after getting started). */
const ORDER = [
  'getting-started', 'roles', 'approvals', 'dashboard', 'nurses', 'contracts', 'credentials', 'eligibility', 'workforce', 'kpi',
  'scheduling', 'attendance', 'notifications', 'announcements', 'administration', 'audit', 'self-service', 'security', 'hospital-workflow',
  'troubleshooting', 'quick-reference',
];

export const SECTIONS: GuideSection[] = ORDER.map((id) => byId(all, id));
if (SECTIONS.length !== all.length) throw new Error('Guidelines: a section is missing from ORDER');

export const sectionNumber = (id: string) => ORDER.indexOf(id) + 1;
export const sectionById = (id: string) => SECTIONS.find((s) => s.id === id);
export const taskById = (sectionId: string, taskId: string): GuideTask | undefined => sectionById(sectionId)?.tasks.find((t) => t.id === taskId);

export { FLOWS, flowById };
export * from './types';
