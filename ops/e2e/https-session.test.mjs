// HTTPS browser test of the session cookies (legacy B-03; spec §3.3, §3.4).
// A real Chromium signs in to the release images behind TLS (run.sh) and checks
// what the backend tests cannot: what the browser stores, sends and withholds.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, request as apiRequest } from 'playwright';

const ORIGIN = 'https://nurse.e2e.test:8443';
const PLAIN = 'http://nurse.e2e.test:8081';
const PASSWORD = process.env.E2E_PASSWORD;
const REFRESH = 'nurseapp_refresh';
const CSRF = 'nurseapp_csrf';

const noProxy = (list) => [list, 'nurse.e2e.test'].filter(Boolean).join(',');

let browser;
let context;
let page;

before(async () => {
  assert.ok(PASSWORD, 'E2E_PASSWORD is set by run.sh');
  browser = await chromium.launch({
    // Resolve the test host name to the TLS front on this machine.
    args: ['--host-resolver-rules=MAP nurse.e2e.test 127.0.0.1'],
    // Reach it directly even where the environment sets an outbound proxy.
    env: { ...process.env, NO_PROXY: noProxy(process.env.NO_PROXY), no_proxy: noProxy(process.env.no_proxy) },
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  // The certificate is self-signed; everything else is ordinary browser behaviour.
  context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  page = await context.newPage();
});
after(async () => { await browser?.close(); });

// Not cookies(ORIGIN): that filters by path, and the refresh cookie lives under /api/v1/auth.
const cookie = async (name) => (await context.cookies()).find((c) => c.name === name && c.domain === 'nurse.e2e.test');
const signedIn = () => page.locator('.app-user').filter({ hasText: 'E2E HR Admin' }).waitFor({ timeout: 15_000 });
const onLoginPage = () => page.waitForURL((u) => u.pathname === '/login', { timeout: 15_000 });

// ── The authenticator app, in the test (RFC 6238: SHA-1, 6 digits, 30 s) ──
let secret = null;
let lastStep = 0;
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
/** A code from a 30-second step later than the last one used: the server accepts each step once. */
async function nextCode() {
  let step = Math.floor(Date.now() / 30_000);
  while (step <= lastStep) {
    await new Promise((r) => setTimeout(r, 1000));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  shareAuthenticator();
  return totp(secret, step);
}
/** smoke.test.mjs signs in as the same HR account after this test (run.sh): it needs the key and the last step used. */
function shareAuthenticator() {
  if (process.env.E2E_MFA_FILE) writeFileSync(process.env.E2E_MFA_FILE, JSON.stringify({ secret, lastStep }), { mode: 0o600 });
}

/** Password, then the second step (spec §3.5): set-up the first time, a code afterwards. */
async function signIn() {
  await page.goto(`${ORIGIN}/login`);
  await page.locator('#email').fill('hr@e2e.test');
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|log ?in/i }).click();
  if (!secret) {
    // HR Admin must set up an authenticator before any session exists.
    await page.getByText('Set up two-factor sign-in').waitFor();
    assert.equal(await cookie(REFRESH), undefined, 'no session after the password alone');
    await page.getByRole('button', { name: 'Cannot scan? Show the key' }).click();
    secret = (await page.getByTestId('mfa-secret').innerText()).replace(/\s/g, '');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await page.getByLabel('Code shown in the app').fill(await nextCode());
    await page.getByRole('button', { name: 'Confirm and continue' }).click();
    const codes = (await page.getByTestId('recovery-codes').innerText()).split(/\s+/).filter(Boolean);
    assert.equal(codes.length, 10, 'ten recovery codes shown once');
    assert.equal(await cookie(REFRESH) !== undefined, true, 'signed in once the authenticator is confirmed');
    await page.getByRole('checkbox', { name: 'I have saved these codes' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
  } else {
    await page.getByLabel('Authenticator code').fill(await nextCode());
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await signedIn();
}

/** POST /auth/refresh outside the browser with a given refresh cookie — as a thief would replay it. */
async function replay(refreshValue) {
  const csrf = 'e2e-replay-csrf';
  const ctx = await apiRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    // The TLS front listens on 127.0.0.1; the Host header names the site.
    const res = await ctx.post('https://127.0.0.1:8443/api/v1/auth/refresh', {
      headers: { Host: 'nurse.e2e.test:8443', Origin: ORIGIN, 'X-CSRF-Token': csrf, Cookie: `${REFRESH}=${refreshValue}; ${CSRF}=${csrf}` },
    });
    return res.status();
  } finally {
    await ctx.dispose();
  }
}

test('the site is served over HTTPS with the production security headers', async () => {
  const res = await page.goto(`${ORIGIN}/login`);
  const h = res.headers();
  assert.equal(res.status(), 200);
  assert.match(h['strict-transport-security'] ?? '', /max-age=31536000/);
  assert.match(h['content-security-policy'] ?? '', /default-src 'self'/);
  assert.equal(h['x-frame-options'], 'DENY');
});

let firstRefresh;

test('sign-in (password, then setting up the authenticator) sets a Secure, HttpOnly refresh cookie limited to the auth endpoints, and no token in web storage', async () => {
  await signIn();
  const refresh = await cookie(REFRESH);
  assert.ok(refresh, 'refresh cookie stored');
  assert.equal(refresh.secure, true);
  assert.equal(refresh.httpOnly, true);
  assert.equal(refresh.sameSite, 'Lax');
  assert.equal(refresh.path, '/api/v1/auth');
  assert.ok(refresh.expires > Date.now() / 1000, 'persistent until the absolute session limit');

  const csrf = await cookie(CSRF);
  assert.ok(csrf, 'CSRF cookie stored');
  assert.equal(csrf.secure, true);
  assert.equal(csrf.httpOnly, false, 'the app reads it after a reload (double submit)');
  assert.equal(csrf.path, '/');

  // Scripts can see the CSRF cookie but never the refresh cookie.
  const visible = await page.evaluate(() => document.cookie);
  assert.ok(visible.includes(`${CSRF}=`));
  assert.ok(!visible.includes(REFRESH));
  // The access token lives in memory only.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  assert.ok(!/eyJ[\w-]+\.[\w-]+\./.test(stored), `no JWT in web storage: ${stored}`);
  firstRefresh = refresh.value;
});

let secondRefresh;

test('a page reload keeps the session and rotates the refresh cookie', async () => {
  const refreshCall = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/refresh'));
  await page.reload();
  assert.equal((await refreshCall).status(), 200);
  await signedIn();
  secondRefresh = (await cookie(REFRESH)).value;
  assert.notEqual(secondRefresh, firstRefresh, 'rotated');
});

test('the Secure cookies are never sent over plain HTTP', async () => {
  /** The Cookie header the browser attaches to a refresh call made from page p. */
  const sentFrom = async (p) => {
    const req = p.waitForRequest((r) => r.url().endsWith('/api/v1/auth/refresh') && r.method() === 'POST');
    // No X-CSRF-Token: the server refuses it before touching the session.
    await p.evaluate(() => fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' }).catch(() => {}));
    return (await (await req).allHeaders()).cookie ?? '';
  };
  const plain = await context.newPage();
  try {
    await plain.goto(`${PLAIN}/login`);
    const overHttp = await sentFrom(plain);
    assert.ok(!overHttp.includes(REFRESH) && !overHttp.includes(CSRF), `sent over HTTP: "${overHttp}"`);
  } finally {
    await plain.close();
  }
  const overHttps = await sentFrom(page);
  assert.ok(overHttps.includes(`${REFRESH}=${secondRefresh}`), 'sent over HTTPS');
  assert.equal((await cookie(REFRESH)).value, secondRefresh, 'the refused probe consumed nothing');
});

test('an expired access token is renewed silently while the app is in use', async () => {
  // ACCESS_TOKEN_TTL_SECONDS=20 in docker-compose.yml.
  await page.waitForTimeout(22_000);
  const before = (await cookie(REFRESH)).value;
  const refreshCall = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/refresh'));
  await page.locator('.app-menu').getByRole('link', { name: 'Notifications' }).click();
  assert.equal((await refreshCall).status(), 200);
  await page.waitForURL((u) => u.pathname === '/notifications');
  await signedIn();
  secondRefresh = (await cookie(REFRESH)).value;
  assert.notEqual(secondRefresh, before, 'rotated again');
});

test('replaying a consumed refresh cookie is rejected and ends the whole session', async () => {
  assert.equal(await replay(firstRefresh), 401);
  // Reuse revokes the family: the current, never-used cookie is dead too.
  await page.reload();
  await onLoginPage();
  assert.equal(await cookie(REFRESH), undefined, 'the failed refresh cleared the cookie');
  assert.equal(await replay(secondRefresh), 401);
});

test('sign-out clears both cookies and the old refresh cookie stops working', async () => {
  await signIn(); // password + a code from the authenticator this time
  const beforeLogout = (await cookie(REFRESH)).value;
  await page.locator('.app-user').hover();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await onLoginPage();
  assert.equal(await cookie(REFRESH), undefined);
  assert.equal(await cookie(CSRF), undefined);
  await page.reload();
  await onLoginPage();
  assert.equal(await replay(beforeLogout), 401);
});
