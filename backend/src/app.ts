import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import { badgeSimulatorOn, type Env } from './config/env.js';
import { createPasswordService, type PasswordService } from './lib/passwords.js';
import type { Db } from './lib/prisma.js';
import { createThrottle } from './lib/throttle.js';
import { createTokenService } from './lib/tokens.js';
import { createAuthenticate } from './middleware/authenticate.js';
import { errorHandler, unknownRoute } from './middleware/errors.js';
import { requestId } from './middleware/request-id.js';
import { createRequestLog, requestLogKey, type RequestLog } from './lib/request-log.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { createMfa } from './modules/auth/mfa.js';
import { createSecretBox, mfaKey } from './lib/secret-box.js';
import { createTelegramGateway, type TelegramGateway } from './lib/telegram.js';
import { createScfhsGateway, type ScfhsGateway } from './lib/scfhs.js';
import { createScfhsService } from './modules/credentials/scfhs.js';
import { createAccountService } from './modules/users/accounts.js';
import { createRoleAssignmentService } from './modules/users/role-assignments.js';
import { createUsersRouter } from './modules/users/routes.js';
import { createInvitationService } from './modules/users/invitations.js';
import { createPasswordResetService } from './modules/users/password-reset.js';
import { createEmailChangeService } from './modules/users/email-change.js';
import { createBaselineImportService } from './modules/administration/baseline-import.js';
import { createCatalogService } from './modules/credentials/catalog.js';
import { createRecordService } from './modules/credentials/records.js';
import { createCredentialsRouter } from './modules/credentials/routes.js';
import { createEligibilityService } from './modules/eligibility/service.js';
import { createEligibilityLogicRouter, type LogicRouterOptions } from './modules/eligibility/logic-routes.js';
import { previousKey } from './lib/keyring.js';
import { createLocalDiskAdapter, createVault, documentKey } from './lib/vault.js';
import { createDocumentAccess, fileHeaders } from './modules/documents/access.js';
import { fieldCryptoFromEnv } from './lib/field-crypto.js';
import { createProtection } from './modules/pdpl/protection.js';
import { createPdplRouter } from './modules/pdpl/register.js';
import { createDataSubjectRouter, createDataSubjectService } from './modules/pdpl/requests.js';
import { createScanner, type UploadScanner } from './lib/scanner.js';
import { createWorkforceRouter } from './modules/workforce/routes.js';
import { createOrgService } from './modules/workforce/org.js';
import { createNurseService } from './modules/nurses/service.js';
import { createNursesRouter } from './modules/nurses/routes.js';
import { createStaffImportService } from './modules/nurses/staff-import.js';
import { createContractService } from './modules/contracts/service.js';
import { createContractsRouter } from './modules/contracts/routes.js';
import { createSchedulingService } from './modules/scheduling/service.js';
import { createSchedulingRouter } from './modules/scheduling/routes.js';
import { createAttendanceService } from './modules/attendance/service.js';
import { createNotificationsRouter } from './modules/notifications/routes.js';
import { createAuditRouter } from './modules/audit/routes.js';
import { createDevConsoleRouter } from './modules/dev-console/routes.js';
import { createFhirRouter } from './modules/interop/fhir-routes.js';
import { createClientAuth } from './modules/interop/api-clients.js';
import { createApiClientRouter } from './modules/interop/api-client-routes.js';
import { createTelegramLinking } from './modules/telegram/linking.js';
import { createAnnouncementService } from './modules/announcements/service.js';
import { createAnnouncementsRouter } from './modules/announcements/routes.js';
import { createTelegramRouter, telegramWebhook } from './modules/telegram/routes.js';

export interface AppDeps {
  env: Env;
  db: Db;
  /** Injectable so tests can use a cheaper bcrypt cost; defaults to env.BCRYPT_ROUNDS. */
  passwords?: PasswordService;
  /** Injectable so tests can simulate infected files and scanner outages; defaults to env.UPLOAD_SCANNER. */
  scanner?: UploadScanner;
  /** Prefix for sign-in throttle keys, so test apps sharing one database do not share counters. */
  throttleNamespace?: string;
  /** Injectable so tests can simulate a failing gateway; defaults to env.NOTIFICATION_DRIVER (D-66). */
  telegram?: TelegramGateway;
  /** Injectable so tests can simulate an unreachable SCFHS; defaults to env.SCFHS_DRIVER (D-64). */
  scfhs?: ScfhsGateway;
  /** Shadow-mode hooks for tests (the re-evaluation after a promotion runs in the background). */
  logic?: LogicRouterOptions;
  /** Injectable so tests can flush it; defaults to one writing to this database. */
  requestLog?: RequestLog;
}

const HEALTH_DB_TIMEOUT_MS = 2000;

/** Builds the Express application without starting a listener (tests use it directly). */
export function createApp({ env, db, passwords = createPasswordService(env.BCRYPT_ROUNDS), scanner = createScanner(env), throttleNamespace = '', telegram = createTelegramGateway(env, db), scfhs = createScfhsGateway(env, db), logic = {}, requestLog = createRequestLog(db, requestLogKey(env.JWT_SECRET)) }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1); // one hop: the hospital reverse proxy
  app.locals.requestLog = requestLog;
  app.use(requestId);
  app.use('/api', requestLog.middleware); // spec §9.2: every API request, after its response
  // One exact origin; credentials allowed because the refresh token travels in a cookie.
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  // The staff import (D-72) sends up to 1,000 rows as JSON; every other request keeps the 1 MB limit.
  const jsonDefault = express.json({ limit: '1mb' });
  const jsonImport = express.json({ limit: '3mb' });
  app.use((req, res, next) => (req.method === 'POST' && /^\/api\/v1\/employees\/import(\/check)?$/.test(req.path) ? jsonImport : jsonDefault)(req, res, next));
  // API responses carry tokens and personal data: never store them in any cache.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(cookieParser());

  // Liveness + database reachability. Deliberately reveals nothing else.
  app.get('/api/v1/health', async (_req, res) => {
    const database = await ping(db).then(() => 'up' as const, () => 'down' as const);
    res.status(database === 'up' ? 200 : 503).json({ status: database === 'up' ? 'ok' : 'degraded', database });
  });

  const tokens = createTokenService(env.JWT_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  // D-63: other systems' client tokens for the FHIR API; failed attempts throttled like sign-ins.
  const clientAuth = createClientAuth(db, env.JWT_SECRET, {
    address: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
    client: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_ACCOUNT, throttleNamespace),
  });
  const authenticate = createAuthenticate(db, tokens, env.CORS_ORIGIN, clientAuth);
  const accountThrottle = createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_ACCOUNT, throttleNamespace);
  const mfa = createMfa(db, env, createSecretBox(mfaKey(env), previousKey(env.MFA_ENCRYPTION_KEY_PREVIOUS)));
  const auth = createAuthService({
    db, env, tokens, passwords, mfa, telegram,
    accountThrottle,
    clientThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });

  const invitations = createInvitationService({
    db, passwords, baseUrl: env.APP_BASE_URL ?? env.CORS_ORIGIN, mailEnabled: Boolean(env.SMTP_HOST),
    throttle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });
  const passwordResets = createPasswordResetService({
    db, passwords, accountThrottle, baseUrl: env.APP_BASE_URL ?? env.CORS_ORIGIN, mailEnabled: Boolean(env.SMTP_HOST),
    clientThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });
  const emailChanges = createEmailChangeService({
    db, passwords, accountThrottle, baseUrl: env.APP_BASE_URL ?? env.CORS_ORIGIN, mailEnabled: Boolean(env.SMTP_HOST),
    clientThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });
  app.use('/api/v1/auth', createAuthRouter(env, auth, authenticate, invitations, passwordResets, mfa, emailChanges));

  // D-53: the document vault, and its single-use links. The link itself is the
  // credential (issued after the usual authorisation), so this route is public.
  const documents = createDocumentAccess(db, createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)));
  app.get('/api/v1/files/:token{/:name}', async (req, res) => {
    const file = await documents.redeem(String(req.params.token), res.locals.requestId);
    res.set(fileHeaders(file, file.inline)).send(file.bytes);
  });

  // The OAuth 2.0 token endpoint for other systems (D-63): public, the client credentials are the check.
  app.post('/api/v1/fhir/token', express.urlencoded({ extended: false, limit: '4kb' }), clientAuth.tokenEndpoint);

  // D-66: Telegram posts the bot's messages here (TELEGRAM_UPDATES=webhook); its secret header is the check.
  const telegramLinking = createTelegramLinking(db, telegram, env.TELEGRAM_BOT_USERNAME);
  app.locals.telegramLinking = telegramLinking; // server.ts polls with it when TELEGRAM_UPDATES=polling
  app.post('/api/v1/telegram/webhook', telegramWebhook(env, telegramLinking));

  // Everything else under /api/v1 requires a signed-in caller. One protected
  // router, so authentication runs once per request; each domain module adds
  // its router here. Anonymous callers get 401 for any path, known or not.
  const api = Router();
  api.use(authenticate);
  const catalog = createCatalogService(db);
  const protection = createProtection(fieldCryptoFromEnv(env));
  const keyStatus = {
    masterKeyId: protection.crypto.masterKeyId, pepperId: protection.crypto.pepperId,
    previous: (['MFA_ENCRYPTION_KEY_PREVIOUS', 'DOCUMENT_ENCRYPTION_KEY_PREVIOUS', 'PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS', 'PDPL_BLIND_INDEX_PEPPER_PREVIOUS'] as const).filter((k) => env[k]),
  };
  // D-69: announcements are sent from their own router and approved in the shared Approvals queue.
  const announcements = createAnnouncementService(db, { emailHourlyLimit: env.EMAIL_HOURLY_LIMIT });
  api.use(createUsersRouter(db, createAccountService(db, passwords), createRoleAssignmentService(db), catalog, createBaselineImportService(db), invitations, passwordResets, mfa, emailChanges, announcements));
  api.use(createWorkforceRouter(db, createOrgService(db)));
  const nurseService = createNurseService(db);
  api.use(createNursesRouter(db, nurseService, createStaffImportService(db, nurseService)));
  api.use(createSchedulingRouter(db, createSchedulingService(db), createAttendanceService(db)));
  api.use(createNotificationsRouter(db));
  api.use(createAnnouncementsRouter(db, announcements));
  api.use(createAuditRouter(db, keyStatus));
  api.use(createPdplRouter(db));
  api.use(createDevConsoleRouter(db, telegram, scfhs.driver, badgeSimulatorOn(env)));
  api.use(createTelegramRouter(db, telegramLinking, env.NOTIFICATION_DRIVER));
  api.use(createEligibilityLogicRouter(db, logic));
  api.use(createFhirRouter(db, protection, env.APP_BASE_URL ?? env.CORS_ORIGIN));
  api.use(createApiClientRouter(db));
  api.use(createDataSubjectRouter(createDataSubjectService({ db, protection, vault: documents.vault, backupRetentionDays: env.BACKUP_RETENTION_DAYS })));
  api.use(createContractsRouter(db, createContractService(db, documents, scanner, env.UPLOAD_MAX_SIZE_BYTES), env.UPLOAD_MAX_SIZE_BYTES));
  api.use(createCredentialsRouter(
    catalog,
    createRecordService(db, documents, scanner, env.UPLOAD_MAX_SIZE_BYTES, protection),
    createEligibilityService(db),
    env.UPLOAD_MAX_SIZE_BYTES,
    createScfhsService(db, scfhs, protection),
  ));
  app.use('/api/v1', api);

  app.use('/api', unknownRoute);
  app.use(errorHandler);
  return app;
}

function ping(db: Db): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('database ping timed out')), HEALTH_DB_TIMEOUT_MS);
  });
  return Promise.race([db.$queryRaw`SELECT 1`, timeout]).finally(() => clearTimeout(timer));
}
