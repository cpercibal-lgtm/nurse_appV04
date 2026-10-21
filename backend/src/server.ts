import dotenv from 'dotenv';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { assertResidency } from './config/residency.js';
import { assertUploadScanner } from './lib/scanner.js';
import { assertRuntimeRole } from './lib/db-role.js';
import { createPrisma } from './lib/prisma.js';
import { describeError, logger } from './lib/logger.js';
import { startScheduler } from './jobs/scheduler.js';
import { dispatchConfigFrom, startEmailDispatcher } from './jobs/email-dispatch.js';
import { createMailer } from './lib/mailer.js';
import { syncLogicVersions } from './modules/eligibility/logic.js';
import { startTelegramUpdates } from './jobs/telegram-updates.js';
import { startTelegramDispatcher } from './jobs/telegram-dispatch.js';
import { createTelegramGateway } from './lib/telegram.js';
import { scfhsDriverOf } from './lib/scfhs.js';
import type { TelegramLinking } from './modules/telegram/linking.js';

// Quiet: dotenv's banner is not JSON and would break the one-line-JSON log format.
dotenv.config({ quiet: true });
const env = loadEnv();
// Fail closed before anything touches data (spec §8.3.6).
assertResidency({
  region: env.DATA_RESIDENCY_REGION,
  allowed: env.PDPL_ALLOWED_REGIONS,
  isProduction: env.NODE_ENV === 'production',
});
// D-10: production refuses to start without the ClamAV scanner for uploads.
assertUploadScanner(env, env.NODE_ENV === 'production');

const db = createPrisma(env.DATABASE_URL);
// Spec §10.7: production runs as the data-only runtime role, never the owner.
await assertRuntimeRole(db, env.NODE_ENV === 'production');
// Spec §10.9 (D-60): a new eligibility logic version in this release starts in shadow.
await syncLogicVersions(db);
const app = createApp({ env, db });

// Jobs run here only in development; production runs `npm run worker` (plan: Jobs).
const stopJobs = env.JOBS_MODE === 'in-process' ? startScheduler(db) : () => undefined;
// E-mail (D-47) goes out from wherever the jobs run.
const stopMail = env.JOBS_MODE === 'in-process' ? startEmailDispatcher(db, createMailer(env), dispatchConfigFrom(env)) : () => undefined;
// Telegram messages to the bot (D-66): polled where the jobs run; the webhook is registered here.
const linking = app.locals.telegramLinking as TelegramLinking;
const stopTelegram = startTelegramUpdates(env, (u) => linking.handleUpdate(u), { poll: env.JOBS_MODE === 'in-process', serves: true });
// Notifications announced by Telegram (D-66), from wherever the jobs run.
const stopTelegramDispatch = env.JOBS_MODE === 'in-process' ? startTelegramDispatcher(db, createTelegramGateway(env, db), env.APP_BASE_URL ?? env.CORS_ORIGIN) : () => undefined;
if (env.NODE_ENV === 'production' && !env.SMTP_HOST) logger.warn('e-mail is off: SMTP_HOST is not set; notifications stay in-app (D-47)');
if (env.NODE_ENV === 'production' && env.NOTIFICATION_DRIVER === 'mock') logger.warn('Telegram is simulated (NOTIFICATION_DRIVER=mock): messages are kept in the Dev Console Telegram inbox and not sent (D-66)');
const scfhsDriver = scfhsDriverOf(env);
if (env.NODE_ENV === 'production' && scfhsDriver === 'mock') logger.warn('SCFHS is simulated (SCFHS_DRIVER=mock): every real licence not in the Dev Console registry answers "not found" and HR is notified; use only with synthetic data (D-64)');
if (env.NODE_ENV === 'production' && scfhsDriver === 'off') logger.warn('SCFHS checks are off (SCFHS_DRIVER unset or off): licences are not checked with SCFHS; HR records website checks by hand (D-74, D-75)');

const server = app.listen(env.PORT, () => {
  logger.info('listening', { port: env.PORT, environment: env.NODE_ENV, region: env.DATA_RESIDENCY_REGION });
});

function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopJobs();
  stopMail();
  stopTelegram();
  stopTelegramDispatch();
  server.close(() => {
    // Write the last buffered request-log rows (spec §9.2) before disconnecting.
    void (app.locals.requestLog as { flush: () => Promise<void> }).flush().finally(() => db.$disconnect().finally(() => process.exit(0)));
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection', describeError(e)));
