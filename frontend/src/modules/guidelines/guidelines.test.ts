// The Guidelines must stay true to the application: every link resolves, every
// workflow exists and lays out cleanly, search answers the questions users ask,
// and the generated manual (Markdown, images, PDF) matches this content.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES } from '../../app/modules';
import { FLOWS, flowById, SECTIONS, sectionById } from './content';
import { flowToSvg, layoutFlow, LIGHT, type BoxShape } from './content/flowLayout';
import { renderManualMarkdown } from './content/markdown';
import { searchGuidelines } from './content/search';
import type { FlowNode } from './content/types';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(__dirname, '..', '..');
const version = (JSON.parse(readFileSync(join(ROOT, 'backend', 'package.json'), 'utf8')) as { version: string }).version;
const PDF = 'AIGH_Nursing_Workforce_User_Manual_V04.pdf';

describe('Guidelines content', () => {
  it('has unique section and task ids, and every related link, route and workflow exists', () => {
    expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(SECTIONS.length);
    const paths = new Set(MODULES.map((m) => m.path));
    for (const s of SECTIONS) {
      if (s.route) expect(paths.has(s.route), `${s.id} → ${s.route}`).toBe(true);
      for (const f of s.flows ?? []) expect(flowById(f), `${s.id} flow ${f}`).toBeDefined();
      expect(new Set(s.tasks.map((t) => t.id)).size, `${s.id} task ids`).toBe(s.tasks.length);
      for (const t of s.tasks) {
        expect(t.steps.length, `${s.id}/${t.id} steps`).toBeGreaterThan(0);
        for (const r of t.related ?? []) expect(sectionById(r), `${s.id}/${t.id} related ${r}`).toBeDefined();
        if (t.flow) expect(flowById(t.flow), `${s.id}/${t.id} flow ${t.flow}`).toBeDefined();
        if (t.status !== 'IMPLEMENTED') expect(t.statusNote, `${s.id}/${t.id} says why it is not fully implemented`).toBeTruthy();
      }
    }
  });

  it('explains every page of the side menu (one row per page in Getting started → The side menu)', () => {
    const menuTable = sectionById('getting-started')!.tables!.find((t) => t.title === 'The side menu')!;
    expect(menuTable.rows.length).toBe(MODULES.length);
  });

  it('guides date corrections through the uploaded copy and a different HR approver', () => {
    const task = sectionById('contracts')!.tasks.find((t) => t.id === 'request-contract-date-change')!;
    expect(task.purpose).toContain('Correct a typing error');
    expect(task.purpose).toContain('match the uploaded contract copy');
    expect(task.before).toContain('The signed contract copy is uploaded (Contract copy). The new dates must be exactly the dates written on it.');
    const reviewStep = task.steps.find((s) => s.includes('Open contract copy'))!;
    expect(reviewStep).toContain('Another HR administrator');
    expect(reviewStep).toContain('requested dates match the document exactly');
    expect(reviewStep).toContain('With no discrepancy they click Approve');
    expect(reviewStep).toContain('otherwise they write a note and click Reject');
    expect(JSON.stringify(task)).not.toMatch(/addendum/i);
  });

  it('every "?" help button points at a section (and task) that exists', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : f.endsWith('.tsx') ? [p] : [];
    });
    let found = 0;
    for (const f of files(SRC)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<GuideHelp section="([^"]+)"(?: task="([^"]+)")?/g)) {
        found += 1;
        const section = sectionById(m[1]!);
        expect(section, `${f}: section ${m[1]}`).toBeDefined();
        if (m[2]) expect(section!.tasks.some((t) => t.id === m[2]), `${f}: task ${m[2]}`).toBe(true);
      }
    }
    expect(found).toBeGreaterThanOrEqual(10);
  });
});

describe('workflows', () => {
  const decisionsAreLast = (nodes: FlowNode[]): boolean => nodes.every((n, i) =>
    (!n.branches || (i === nodes.length - 1 && n.kind === 'decision' && n.branches.length >= 2 && n.branches.length <= 4))
    && (n.branches ?? []).every((b) => b.nodes.length > 0 && decisionsAreLast(b.nodes)));

  it('are well formed: unique ids, decisions last with 2–4 branches', () => {
    expect(new Set(FLOWS.map((f) => f.id)).size).toBe(FLOWS.length);
    for (const f of FLOWS) expect(decisionsAreLast(f.nodes), f.id).toBe(true);
  });

  it('lay out without overlapping boxes, inside the image', () => {
    for (const f of FLOWS) {
      const l = layoutFlow(f);
      const boxes = l.shapes.filter((s): s is BoxShape => s.type === 'box');
      for (const b of boxes) {
        expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= l.width && b.y + b.h <= l.height, `${f.id}: box inside`).toBe(true);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!; const b = boxes[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${f.id}: boxes ${i} and ${j} overlap`).toBe(false);
      }
    }
  });
});

describe('search', () => {
  const top = (q: string) => { const h = searchGuidelines(q)[0]; return h ? `${h.section.id}${h.task ? `/${h.task.id}` : ''}` : ''; };
  it.each([
    ['How do I renew a license?', 'self-service/my-renewal'],
    ['How do I add a credential?', 'self-service/my-credentials'],
    ['Why is a nurse ineligible?', 'eligibility/resolve-ineligible'],
    ['How do I configure a credential requirement?', 'credentials/requirements'],
    ['How do I publish a roster?', 'scheduling/publish'],
    ["Why can't I see a nurse?", 'nurses/find-nurse'],
    ['How do I approve a request?', 'approvals/decide-request'],
    ['What does TRANSITION mean?', 'credentials/requirements'],
    ['What is ELIGIBLE_WITH_GRACE?', 'eligibility/read-eligibility'],
    ['correct contract date', 'contracts/request-contract-date-change'],
    ['contract date typo', 'contracts/request-contract-date-change'],
    ['wrong contract date', 'contracts/request-contract-date-change'],
  ])('%s → %s', (q, expected) => expect(top(q)).toBe(expected));

  it('finds nothing for nonsense and for an empty query', () => {
    expect(searchGuidelines('')).toEqual([]);
    expect(searchGuidelines('zzqx')).toEqual([]);
  });
});

describe('the generated manual matches the content (npm run docs:manual)', () => {
  it('docs/USER_MANUAL.md', () => {
    expect(readFileSync(join(ROOT, 'docs', 'USER_MANUAL.md'), 'utf8')).toBe(renderManualMarkdown(version) + '\n');
  });

  it('docs/generated/flows/*.svg', () => {
    for (const f of FLOWS) {
      const file = join(ROOT, 'docs', 'generated', 'flows', `${f.id}.svg`);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, 'utf8'), f.id).toBe(flowToSvg(layoutFlow(f), LIGHT) + '\n');
    }
  });

  it('the PDF exists, and the copy the page offers is the same file', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'generated', PDF));
    const pub = readFileSync(join(ROOT, 'frontend', 'public', 'guidelines', PDF));
    expect(doc.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pub.equals(doc)).toBe(true);
  });
});
