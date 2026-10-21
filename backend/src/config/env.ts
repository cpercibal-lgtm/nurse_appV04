import { z } from 'zod';

// Every setting the backend reads is declared here and validated once at
// startup, so a missing or malformed value fails fast instead of surfacing as
// a confusing error deep inside a request.
const int = (def: number) => z.coerce.number().int().positive().default(def);
const key32 = () => z.string().default('').refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3001),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),
  // Residency values are checked by assertResidency (config/residency.ts), which
  // fails closed on empty values — so no defaults here.
  DATA_RESIDENCY_REGION: z.string().default(''),
  PDPL_ALLOWED_REGIONS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean)),

  // ── Authentication (spec §3.3, §3.4; decision D-6) ──────────────────────────
  /** HS256 signing key; spec §3.4: "minimum 256-bit random value". No default. */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters (256-bit random value)'),
  /** Access token lifetime — spec §3.4: 15 minutes. */
  ACCESS_TOKEN_TTL_SECONDS: int(900),
  /** Idle limit: a session not refreshed within this window ends — spec §3.3 "one hour of validity" (D-6). */
  SESSION_IDLE_SECONDS: int(3600),
  /** Absolute boundary regardless of activity — spec §3.3/§3.4: 24 hours (D-6). */
  SESSION_ABSOLUTE_SECONDS: int(86400),
  /** bcrypt cost — spec §3.4 BCRYPT_ROUNDS=12. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  // ── MFA (spec §3.5) ──────────────────────────────────────────────────────
  /**
   * Roles whose holders must use an authenticator app, comma-separated, or
   * "none". Spec §3.5 names HR Admin and System Admin; production refuses a
   * list without both. Break-glass is never asked (spec §3.6).
   */
  MFA_REQUIRED_ROLES: z
    .string()
    .default('SYSTEM_ADMIN,HR_ADMIN,SUPERVISOR,NURSING_ADMIN,NURSING_DIRECTOR')
    .transform((s) => (s.trim().toLowerCase() === 'none' ? [] : s.split(',').map((r) => r.trim()).filter(Boolean)))
    .pipe(z.array(z.enum(['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR', 'NURSING_ADMIN', 'NURSING_DIRECTOR']))),
  /** 32 random bytes, base64: encrypts the authenticator secrets at rest. Required in production. */
  MFA_ENCRYPTION_KEY: z
    .string()
    .default('')
    .refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  // Login attempt limits: spec §3.3 requires "account/client attempt limits" but
  // gives no numbers (REQUIREMENT NOT ESTABLISHED). Defaults mirror the spec's
  // registration throttle (5 per 15 minutes) for accounts; the per-client value
  // is an implementation default. Confirm both with hospital IT.
  LOGIN_THROTTLE_WINDOW_SECONDS: int(900),
  LOGIN_THROTTLE_MAX_PER_ACCOUNT: int(5),
  LOGIN_THROTTLE_MAX_PER_CLIENT: int(20),
  // ── Uploads (spec §5.1.5, §5.3.2; decision D-10) ─────────────────────────
  /** Local document storage root (never served directly). */
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /** D-54 (spec §8.3.4): wraps each employee's data key for sensitive fields. 32 random bytes, base64. Required in production. */
  PDPL_FIELD_ENCRYPTION_KEY: z
    .string()
    .default('')
    .refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  /** D-54: keys the blind index (HMAC) for identifier search. 32 random bytes, base64. Required in production. */
  PDPL_BLIND_INDEX_PEPPER: z
    .string()
    .default('')
    .refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  /**
   * Spec §8.3.3 / §10.6: days a database backup is kept (ops/backup BACKUP_RETENTION_DAYS —
   * keep the two equal). An erasure record states when the last backup holding the old ciphertext expires.
   */
  BACKUP_RETENTION_DAYS: int(30),
  /** D-53: 32 random bytes, base64 — wraps each document's own encryption key. Required in production. */
  DOCUMENT_ENCRYPTION_KEY: z
    .string()
    .default('')
    .refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  /**
   * B-18 key rotation: the key being replaced, set beside the new one until
   * `npm run keys:rotate` has moved everything (docs/DEPLOYMENT.md §3). Optional.
   */
  MFA_ENCRYPTION_KEY_PREVIOUS: key32(),
  DOCUMENT_ENCRYPTION_KEY_PREVIOUS: key32(),
  PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS: key32(),
  PDPL_BLIND_INDEX_PEPPER_PREVIOUS: key32(),
  /** Spec §5.1.5: 10 MB per upload, configurable. */
  UPLOAD_MAX_SIZE_BYTES: int(10 * 1024 * 1024),
  /** D-10: dev marks files CLEAN after magic-byte checks; production requires clamav. */
  UPLOAD_SCANNER: z.enum(['dev-magic-bytes', 'clamav']).default('dev-magic-bytes'),
  /** clamd TCP endpoint (spec §5.3.2); required when UPLOAD_SCANNER=clamav. */
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: int(3310),
  /** Per clamd call; spec §5.3.2: 30 s. */
  CLAMAV_TIMEOUT_MS: int(30_000),
  /** Spec §5.3.2 rule 7: older signatures raise an operations alert (error log). */
  CLAMAV_MAX_SIGNATURE_AGE_HOURS: int(48),
  // ── E-mail (spec §7.2; decision D-47: the hospital SMTP relay) ────────────
  /** Relay host; empty = e-mail off (notifications stay in-app, marked SKIPPED). */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: int(587),
  /** false = STARTTLS on the submission port (required — never plain text); true = implicit TLS (465). */
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** e.g. "AIGH Workforce <nurseapp@aigh.sa>" — required when SMTP_HOST is set. */
  SMTP_FROM: z.string().default(''),
  /** A monitored HR mailbox, not the service account (spec §7.2). */
  SMTP_REPLY_TO: z.string().default(''),
  /** Verify the relay's certificate; refused as false in production. */
  SMTP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Spec §7.2: up to 8 attempts, one minute apart. */
  SMTP_RETRY_MAX: z.coerce.number().int().min(1).max(20).default(8),
  SMTP_RETRY_DELAY_SECONDS: int(60),
  /** D-69: most e-mails sent in any 60 minutes, kept under the provider's limit (UltaMail: 200 per hour
   *  per domain); 0 = no limit. Mail over it waits as PENDING, outbox and urgent mail first. */
  EMAIL_HOURLY_LIMIT: z.coerce.number().int().min(0).max(100_000).default(0),
  /** Where links in e-mails point (the app's public URL); defaults to CORS_ORIGIN. */
  APP_BASE_URL: z.string().url().optional(),
  /** Spec §3.6: people alerted by e-mail when the break-glass account signs in (the CEO and IT Director), comma-separated. */
  BREAK_GLASS_ALERT_EMAILS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((a) => a.trim()).filter(Boolean))
    .pipe(z.array(z.string().email())),
  // ── Telegram (D-66, replacing SMS: D-48, D-59) ─────────────────────────────
  /** mock: messages are saved to mock_telegram_outbox (the Dev Console) and never leave the server.
   *  telegram: the Telegram Bot API. */
  NOTIFICATION_DRIVER: z.enum(['mock', 'telegram']).default('mock'),
  /** The bot's token from @BotFather; required when NOTIFICATION_DRIVER=telegram. A secret. */
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  /** The bot's username without "@"; required when NOTIFICATION_DRIVER=telegram. */
  TELEGRAM_BOT_USERNAME: z.string().default('').transform((s) => s.trim().replace(/^@/, '')).pipe(z.string().regex(/^([A-Za-z][A-Za-z0-9_]{3,31})?$/, 'a Telegram bot username')),
  /** How the bot receives messages (/start <token> links an account): polling = the jobs process asks Telegram
   *  (works without a public address, e.g. a development PC); webhook = Telegram posts to /api/v1/telegram/webhook. */
  TELEGRAM_UPDATES: z.enum(['polling', 'webhook']).default('polling'),
  /** Sent by Telegram with every webhook call and checked; required for webhook. 1–256 of A–Z a–z 0–9 _ -. */
  TELEGRAM_WEBHOOK_SECRET: z.string().default('').pipe(z.string().regex(/^[A-Za-z0-9_-]{0,256}$/, 'letters, digits, _ and - only')),
  /** Spec §3.6: Telegram chats messaged when the break-glass account signs in (the CEO and IT Director), comma-separated chat ids. */
  BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((c) => c.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^-?[1-9]\d{0,19}$/, 'a Telegram chat id, e.g. 123456789'))),
  // ── SCFHS licence verification (spec §5.4, D-64) ──────────────────────────
  /** mock: answers come from the simulated SCFHS registry (Dev Console) — until the hospital has access to
   *  the SCFHS verification service. live: the SCFHS API (not built yet: needs the SCFHS agreement, U3).
   *  off: no licence is checked. Unset: off in production (the simulated registry answers "not found" for
   *  every real licence), mock elsewhere — see scfhsDriverOf in lib/scfhs.ts. */
  SCFHS_DRIVER: z.enum(['mock', 'live', 'off']).optional(),
  /** The SCFHS verification endpoint and API key; required when SCFHS_DRIVER=live. */
  SCFHS_API_URL: z.string().default(''),
  SCFHS_API_KEY: z.string().default(''),
  // ── Badge simulator (spec §14.2, D-65) ─────────────────────────────────────
  /** The Dev Console badge simulator, which writes clock events as if from the badge system. Off in production
   *  unless set to on (fabricated attendance must not reach payroll by accident); on elsewhere. */
  BADGE_SIMULATOR: z.enum(['on', 'off']).optional(),
  // ── Background jobs (spec §10.2; plan "Jobs") ─────────────────────────────
  /** in-process: the API runs the scheduler (development). worker: a separate `npm run worker` runs it (production). off: nothing runs. */
  JOBS_MODE: z.enum(['in-process', 'worker', 'off']).default('in-process'),
  /** Set when running behind the reverse proxy so req.ip is the client, not the proxy. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

/** D-65: whether the Dev Console badge simulator may write events. */
export const badgeSimulatorOn = (env: Pick<Env, 'BADGE_SIMULATOR' | 'NODE_ENV'>) => (env.BADGE_SIMULATOR ?? (env.NODE_ENV === 'production' ? 'off' : 'on')) === 'on';

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.superRefine((e, ctx) => {
    if (e.SMTP_HOST && !e.SMTP_FROM) ctx.addIssue({ code: 'custom', path: ['SMTP_FROM'], message: 'required when SMTP_HOST is set' });
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME'] as const) {
      if (e.NOTIFICATION_DRIVER === 'telegram' && !e[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when NOTIFICATION_DRIVER=telegram' });
    }
    if (e.NOTIFICATION_DRIVER === 'telegram' && e.TELEGRAM_UPDATES === 'webhook' && e.TELEGRAM_WEBHOOK_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['TELEGRAM_WEBHOOK_SECRET'], message: 'at least 32 characters with TELEGRAM_UPDATES=webhook (openssl rand -hex 32)' });
    }
    for (const k of ['SCFHS_API_URL', 'SCFHS_API_KEY'] as const) {
      if (e.SCFHS_DRIVER === 'live' && !e[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when SCFHS_DRIVER=live' });
    }
    if (e.NODE_ENV === 'production' && !e.DOCUMENT_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DOCUMENT_ENCRYPTION_KEY'], message: 'required in production (openssl rand -base64 32)' });
    }
    for (const k of ['PDPL_FIELD_ENCRYPTION_KEY', 'PDPL_BLIND_INDEX_PEPPER'] as const) {
      if (e.NODE_ENV === 'production' && !e[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required in production (openssl rand -base64 32)' });
    }
    // Each key protects something different: one leaked key must not open the others.
    const keys = (['MFA_ENCRYPTION_KEY', 'DOCUMENT_ENCRYPTION_KEY', 'PDPL_FIELD_ENCRYPTION_KEY', 'PDPL_BLIND_INDEX_PEPPER',
      'MFA_ENCRYPTION_KEY_PREVIOUS', 'DOCUMENT_ENCRYPTION_KEY_PREVIOUS', 'PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS', 'PDPL_BLIND_INDEX_PEPPER_PREVIOUS'] as const).filter((k) => e[k]);
    // A previous key makes sense only beside a new one (B-18).
    for (const k of ['MFA_ENCRYPTION_KEY', 'DOCUMENT_ENCRYPTION_KEY', 'PDPL_FIELD_ENCRYPTION_KEY', 'PDPL_BLIND_INDEX_PEPPER'] as const) {
      if (e[`${k}_PREVIOUS`] && !e[k]) ctx.addIssue({ code: 'custom', path: [`${k}_PREVIOUS`], message: `set only together with a new ${k}` });
    }
    const seen = new Map<string, string>();
    for (const k of keys) {
      const other = seen.get(e[k]);
      if (e.NODE_ENV === 'production' && other) ctx.addIssue({ code: 'custom', path: [k], message: `must differ from ${other}` });
      seen.set(e[k], k);
    }
    if (e.NODE_ENV === 'production' && !e.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['MFA_ENCRYPTION_KEY'], message: 'required in production (openssl rand -base64 32)' });
    }
    if (e.NODE_ENV === 'production' && !(e.MFA_REQUIRED_ROLES.includes('SYSTEM_ADMIN') && e.MFA_REQUIRED_ROLES.includes('HR_ADMIN'))) {
      ctx.addIssue({ code: 'custom', path: ['MFA_REQUIRED_ROLES'], message: 'must include SYSTEM_ADMIN and HR_ADMIN in production (spec §3.5)' });
    }
    if (e.NODE_ENV === 'production' && !e.SMTP_TLS_REJECT_UNAUTHORIZED) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_TLS_REJECT_UNAUTHORIZED'], message: 'must stay true in production (verify the relay certificate)' });
    }
  }).safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return parsed.data;
}
