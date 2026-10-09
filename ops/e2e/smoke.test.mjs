// Smoke journeys in Chromium, Firefox and WebKit, with an automated
// accessibility scan (axe-core, WCAG 2.2 A/AA rules) of every page HR can open.
// Runs after https-session.test.mjs in run.sh, against the same release images
// behind TLS; README.md "Smoke and accessibility". Any URL works too:
//
//   E2E_BASE_URL=http://localhost:5274 E2E_EMAIL=… E2E_PASSWORD=… node --test smoke.test.mjs
//
// What it proves per browser: sign-in, every menu page renders without a crash
// or an uncaught script error, a write survives a reload, Arabic switches the
// layout to right-to-left, System Admin pages are not offered to HR, sign-out
// ends access. Accessibility: a rule violation fails the run unless the rule is
// listed in a11y-known.json (known findings with an owner, fixed one by one).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const BASE = (process.env.E2E_BASE_URL ?? 'https://nurse.e2e.test:8443').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL ?? 'hr@e2e.test';
const PASSWORD = process.env.E2E_PASSWORD;
const MFA_FILE = process.env.E2E_MFA_FILE; // the HR authenticator, from https-session.test.mjs
const REPORT_DIR = process.env.E2E_REPORT_DIR;
const ENGINES = { chromium, firefox, webkit };
const BROWSERS = (process.env.E2E_BROWSERS ?? 'chromium,firefox,webkit').split(',').map((b) => b.trim()).filter(Boolean);
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const KNOWN = JSON.parse(readFileSync(new URL('./a11y-known.json', import.meta.url), 'utf8')).rules ?? {};
const TEST_HOST = new URL(BASE).hostname === 'nurse.e2e.test';
const STEP = { timeout: 180_000 }; // a hang fails the step instead of the whole job

assert.ok(PASSWORD, 'E2E_PASSWORD is required');
for (const b of BROWSERS) assert.ok(ENGINES[b], `unknown browser ${b} (chromium, firefox, webkit)`);

// ── The authenticator, shared with https-session.test.mjs through E2E_MFA_FILE ──
function totp(base32, step) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32.replace(/\s/g, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
/** A code from a 30-second step after the last one used by either test: the server accepts each step once. */
async function nextCode() {
  assert.ok(MFA_FILE && existsSync(MFA_FILE), 'the account asks for an authenticator code, but E2E_MFA_FILE is missing (run after https-session.test.mjs)');
  const state = JSON.parse(readFileSync(MFA_FILE, 'utf8'));
  let step = Math.floor(Date.now() / 30_000);
  while (step <= state.lastStep) {
    await new Promise((r) => setTimeout(r, 1000));
    step = Math.floor(Date.now() / 30_000);
  }
  writeFileSync(MFA_FILE, JSON.stringify({ ...state, lastStep: step }));
  return totp(state.secret, step);
}

// ── Accessibility findings, collected over all browsers and pages ──
const findings = new Map(); // rule → { impact, help, url, pages: Set, nodes, browsers: Set, samples: Map }
function record(browserName, where, violations) {
  for (const v of violations) {
    const f = findings.get(v.id) ?? { impact: v.impact, help: v.help, url: v.helpUrl, pages: new Set(), nodes: 0, browsers: new Set(), samples: new Map() };
    f.pages.add(where);
    f.browsers.add(browserName);
    f.nodes += v.nodes.length;
    for (const n of v.nodes) {
      // Grouped by what to fix: the element, and for contrast its colours and ratio.
      const c = n.any.find((a) => a.id === 'color-contrast')?.data;
      const why = (n.failureSummary ?? '').replace(/\s+/g, ' ').replace(/^Fix (any|all) of the following: /, '').slice(0, 200);
      const key = n.target.join(' ') + (c ? ` — ${c.fgColor} on ${c.bgColor} = ${c.contrastRatio}:1 (needs ${c.expectedContrastRatio})` : ` — ${n.html.slice(0, 120)} — ${why}`);
      const s = f.samples.get(key) ?? { count: 0, pages: new Set() };
      s.count += 1;
      s.pages.add(where);
      f.samples.set(key, s);
    }
    findings.set(v.id, f);
  }
}
function summary() {
  const rows = [...findings].sort(([, a], [, b]) => b.nodes - a.nodes).map(([id, f]) =>
    `| ${id} | ${f.impact} | ${KNOWN[id] ? 'known' : '**new**'} | ${f.nodes} | ${[...f.pages].sort().join(', ')} | ${[...f.browsers].join(', ')} | ${f.help} |`);
  const details = [...findings].map(([id, f]) => [`## ${id}: ${f.help}`, f.url, '',
    ...[...f.samples].sort(([, a], [, b]) => b.count - a.count).slice(0, 25)
      .map(([k, s]) => `- ${s.count}× \`${k}\` (${[...s.pages].sort().join(', ')})`), ''].join('\n'));
  return ['# Accessibility scan (axe-core, WCAG 2.2 A/AA rules)', '', `Site: ${BASE} · ${new Date().toISOString()}`, '',
    rows.length ? '| Rule | Impact | Status | Elements | Pages | Browsers | What |\n|---|---|---|---|---|---|---|\n' + rows.join('\n') : 'No violations.', '',
    ...details].join('\n');
}
after(() => {
  if (!findings.size) return;
  const text = summary();
  console.log(`\n${text}`);
  if (REPORT_DIR) { mkdirSync(REPORT_DIR, { recursive: true }); writeFileSync(`${REPORT_DIR}/a11y-report.md`, text); }
});

for (const name of BROWSERS) {
  describe(`smoke — ${name}`, () => {
    let browser;
    let context;
    let page;
    const scriptErrors = [];
    let newViolations = []; // per test: reset by each test that scans

    before(async () => {
      browser = await ENGINES[name].launch({
        // The test host is the TLS front on this machine: Chromium maps it itself; Firefox and WebKit
        // read the hosts file (CI adds the line; run.sh falls back to Chromium only without it).
        ...(TEST_HOST && name === 'chromium' ? { args: ['--host-resolver-rules=MAP nurse.e2e.test 127.0.0.1'] } : {}),
      });
      context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1366, height: 900 } });
      page = await context.newPage();
      page.on('pageerror', (err) => scriptErrors.push(`${page.url()}: ${err.message}`));
    });
    after(async () => { await browser?.close(); });

    /** The page has finished loading: no skeleton or spinner left (not "network idle": the notification badge polls). */
    async function settled() {
      await page.waitForLoadState('load');
      for (const busy of ['.ant-skeleton', '.ant-spin-spinning']) {
        await page.locator(busy).first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
      }
      // Fonts loaded and two frames rendered: Firefox once measured the Guidelines search button before the
      // flexible search box had its final width (a one-off target-size finding).
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
      await page.waitForTimeout(300);
    }
    async function scan(where) {
      // Judge the final colours, not a frame of a 0.2 s fade (a button turning disabled once measured 2.65:1
      // mid-way). Only during the scan: Ant Design's popups finish opening on transitionend, so the style must
      // not stay. Inserted directly (addStyleTag can wait for a load event WebKit does not fire).
      await page.evaluate(() => {
        const s = document.createElement('style');
        s.id = 'e2e-scan-no-motion';
        s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
        document.head.append(s);
      });
      const result = await new AxeBuilder({ page }).withTags(WCAG).analyze()
        .finally(() => page.evaluate(() => document.getElementById('e2e-scan-no-motion')?.remove()));
      record(name, where, result.violations);
      for (const v of result.violations) if (!KNOWN[v.id]) newViolations.push(`${where}: ${v.id} (${v.impact}, ${v.nodes.length}×) ${v.help}`);
    }
    /** Fails on violations of rules not in a11y-known.json since the last check (each test judges its own pages). */
    function assertNoNewViolations() {
      const found = newViolations;
      newViolations = [];
      assert.deepEqual(found, [], `accessibility rules not in a11y-known.json:\n${found.join('\n')}`);
    }
    function assertHealthy(where) {
      assert.equal(scriptErrors.length, 0, `uncaught script errors:\n${scriptErrors.join('\n')}`);
      return page.locator('.page-error').count().then((n) => assert.equal(n, 0, `${where} shows the error screen`));
    }

    test('signs in (password, then the authenticator when the account has one)', STEP, async () => {
      // Through the browser, which resolves the test host (context.request runs in Node and would need the hosts file).
      const health = await page.goto(`${BASE}/api/v1/health`);
      assert.equal(health?.status(), 200, 'the API is up');
      await page.goto(`${BASE}/login`);
      await settled();
      await scan('/login');
      await page.locator('#email').fill(EMAIL);
      await page.locator('#password').fill(PASSWORD);
      await page.getByRole('button', { name: /sign in|log ?in/i }).click();
      const code = page.getByLabel('Authenticator code');
      const menu = page.locator('.app-menu');
      await Promise.race([code.waitFor({ timeout: 20_000 }), menu.waitFor({ timeout: 20_000 })]);
      assert.equal(await page.getByText('Set up two-factor sign-in').count(), 0, 'the account has no authenticator yet: run after https-session.test.mjs');
      if (await code.isVisible()) {
        await code.fill(await nextCode());
        await page.getByRole('button', { name: 'Verify' }).click();
      }
      await menu.waitFor({ timeout: 20_000 });
      await assertHealthy('sign-in');
      assertNoNewViolations();
    });

    test('every page in the menu opens without an error and passes the accessibility scan', STEP, async () => {
      const paths = [...new Set(await page.locator('.app-menu a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href'))))];
      assert.ok(paths.length >= 10, `the HR menu lists the pages (found ${paths.length})`);
      for (const path of paths) {
        await page.locator(`.app-menu a[href="${path}"]`).click();
        await page.waitForURL((u) => u.pathname === path, { timeout: 15_000 });
        await settled();
        await assertHealthy(path);
        await scan(path);
      }
      assertNoNewViolations();
    });

    test('a skip link comes first, shows when focused, and moves focus to the main content (WCAG 2.4.1)', STEP, async () => {
      await page.goto(`${BASE}/`);
      await settled();
      const link = page.locator('a.skip-link');
      assert.equal(await page.evaluate(() => document.querySelector('a')?.className), 'skip-link', 'the skip link is the first link on the page');
      await link.focus();
      const box = await link.boundingBox();
      assert.ok(box && box.y >= 0, 'it is on screen while it has focus');
      await link.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content', 'focus moved to the main content');
    });

    test('creates a department that is still there after a reload', STEP, async () => {
      const code = `E2E${name.slice(0, 2).toUpperCase()}${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
      await page.goto(`${BASE}/workforce`);
      await settled();
      await page.getByRole('tab', { name: 'Departments' }).click();
      await page.getByRole('button', { name: 'Add department' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Code').fill(code);
      await dialog.getByLabel('Name').fill(`Smoke test department (${name})`);
      // A WebKit run once never sent the request (no POST in the API log) and only the cell wait below timed
      // out. Say which step failed: the form did not take the text, the click did not submit, or the API refused.
      assert.equal(await dialog.getByLabel('Code').inputValue(), code, 'the Code field took the text');
      const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/departments', { timeout: 15_000 });
      await dialog.getByRole('button', { name: 'Submit' }).click();
      const response = await posted.catch(async () => {
        const shown = await dialog.innerText().catch(() => '(the dialog is gone)');
        throw new Error(`Submit sent no POST /api/v1/departments within 15 s; the dialog shows: ${shown.replace(/\s+/g, ' ').slice(0, 300)}`);
      });
      assert.ok(response.ok(), `POST /api/v1/departments answered ${response.status()}`);
      await page.getByRole('cell', { name: code, exact: true }).waitFor({ timeout: 15_000 });
      await page.reload();
      await settled();
      await page.getByRole('tab', { name: 'Departments' }).click();
      await page.getByRole('cell', { name: code, exact: true }).waitFor({ timeout: 15_000 });
      await assertHealthy('/workforce');
    });

    test('Arabic switches the layout to right-to-left, and the pages still pass the scan', STEP, async () => {
      await page.goto(`${BASE}/`);
      await settled();
      await page.locator('.app-header button', { hasText: 'ع' }).click();
      await page.locator('html[dir="rtl"][lang="ar"]').waitFor({ timeout: 15_000 });
      for (const path of ['/', '/workforce', '/kpi']) {
        await page.goto(`${BASE}${path}`);
        await settled();
        assert.equal(await page.locator('html').getAttribute('dir'), 'rtl', `${path} stays right-to-left after loading`);
        await assertHealthy(`${path} (ar)`);
        await scan(`${path} (ar)`);
      }
      await page.locator('.app-header button', { hasText: 'EN' }).click(); // back to English before judging
      await page.locator('html[dir="ltr"]').waitFor({ timeout: 15_000 });
      assertNoNewViolations();
    });

    test('System Admin pages are not offered to HR', STEP, async () => {
      const paths = await page.locator('.app-menu a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      assert.ok(!paths.includes('/audit'), 'the audit trail (System Admin only, D-20) is not in the HR menu');
    });

    test('sign-out ends access: protected pages go back to sign-in', STEP, async () => {
      await page.locator('.app-avatar').hover();
      await page.locator('[data-menu-id$="-logout"]').click(); // by its key: works in either language
      await page.waitForURL((u) => u.pathname === '/login', { timeout: 15_000 });
      // Typed into the address bar, as a user would. Not page.goto: the app redirects to /login before the
      // page has finished loading, which Firefox reports as an aborted goto (wording varies by version).
      const loaded = page.waitForEvent('load', { timeout: 15_000 });
      await page.evaluate((url) => { window.location.href = url; }, `${BASE}/nurses`);
      await loaded; // a new document for /nurses was loaded …
      await page.waitForURL((u) => u.pathname === '/login', { timeout: 15_000 }); // … and sent to sign-in
      await page.locator('#email').waitFor({ timeout: 15_000 });
      await assertHealthy('after sign-out');
    });
  });
}
