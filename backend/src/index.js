require('dotenv').config();
// Resolve/auto-generate JWT_SECRET + Z_CHAT_ENCRYPTION_KEY into process.env
// BEFORE any module that reads them at require-time (./auth, crypto consumers).
require('./util/instanceSecrets').bootstrapSecrets();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const pool = require('./db');
const { router: authRouter, authMiddleware, ensureTables, verifyToken } = require('./auth');
const { router: messagesRouter } = require('./routes/messages');
const { router: webhookRouter } = require('./routes/webhook');
const { router: categoriesRouter } = require('./routes/categories');
const { router: contactFieldsRouter } = require('./routes/contactFields');
const { router: usersRouter } = require('./routes/users');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { router: templatesRouter, syncAllAccountTemplates } = require('./routes/templates');
const { router: broadcastsRouter } = require('./routes/broadcasts');
const { router: chatbotsRouter } = require('./routes/chatbots');
const { router: mediaRouter } = require('./routes/media');
const { router: mediaLibraryRouter } = require('./routes/mediaLibrary');
const mediaStorage = require('./util/pgStorage');
const { router: whatsappAccountsRouter } = require('./routes/whatsappAccounts');
const {
  router: googleIntegrationsRouter,
  publicRouter: googleIntegrationsPublicRouter,
} = require('./routes/googleIntegrations');
const { router: agentsRouter } = require('./routes/agents');
const { router: agentConversationRouter } = require('./routes/agentConversation');
const { router: aiModelsRouter } = require('./routes/aiModels');
const { router: eventsRouter } = require('./routes/events');
const { router: dashboardRouter } = require('./routes/dashboard');
const { router: pipelinesRouter } = require('./routes/pipelines');
const { adminRouter: mcpAdminRouter, apiRouter: mcpApiRouter, ensureMcpTables } = require('./routes/mcp');
const { mcpHttpHandler } = require('./mcpHttp');
const { startWorker: startMediaWorker, shutdown: shutdownMediaQueue } = require('./queue/mediaQueue');
const { startSendWorker, shutdownSendQueue } = require('./queue/sendQueue');
const { startAgentWorker, shutdownAgentQueue } = require('./queue/agentQueue');
const { reconcileMessageStatuses } = require('./services/statusReconciler');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// CORS_ORIGIN may be a single origin or a comma-separated list (e.g.
// "http://localhost:8080,https://zenchat.axxeler.in"). Split it so each
// origin is matched individually — otherwise the whole joined string becomes
// one array entry that no browser Origin header can ever equal.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Dev-only convenience origins (Vite dev server, an ad-hoc ngrok tunnel). These
// are NEVER allowed in production — a public dev origin with credentials:true is
// a CSRF foothold. Production trusts only the explicit CORS_ORIGIN list (+ same
// -machine localhost via isLocalOrigin below).
const DEV_ORIGINS = process.env.NODE_ENV !== 'production'
  ? ['http://localhost:5173', 'http://localhost:8080']
  : [];
const ALLOWED_ORIGINS = [...CORS_ORIGINS, ...DEV_ORIGINS].filter(Boolean);

// A local `docker compose up -d` serves the app at http://localhost:8080 (or a
// custom HTTP_PORT) behind a same-origin nginx proxy, so requests carry an
// Origin like http://localhost:8080 that won't match CORS_ORIGIN. Allow any
// localhost / 127.0.0.1 origin (any port) so the documented local install works
// out of the box. Same-machine only and auth cookies are sameSite=strict.
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

// First configured origin for the CSP connect-src wss:// directive. No public
// fallback — when CORS_ORIGIN is unset, the wss directive is simply omitted.
const CORS_DOMAIN = (CORS_ORIGINS[0] || '').replace(/^https?:\/\//, '');

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", ...(CORS_DOMAIN ? [`wss://${CORS_DOMAIN}`] : [])],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || isLocalOrigin(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

app.use(cookieParser());
// Capture the raw request body so the webhook route can verify Meta's
// X-Hub-Signature-256 HMAC over the exact bytes Meta signed.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Serve uploaded files statically
app.use('/uploads', express.static(UPLOAD_DIR));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  keyGenerator: (req) => {
    // Per-user bucket so concurrent users never share each other's limit. Use a
    // VERIFIED token (not jwt.decode) so a forged cookie can't claim another
    // user's key to drain their quota, nor mint fresh buckets to bypass the cap.
    // Unauthenticated / invalid → fall back to the client IP.
    const payload = verifyToken(req.cookies?.z_chat_token);
    if (payload?.id != null) return `user:${payload.id}`;
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});
app.use(apiLimiter);

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Public routes (Meta webhook — no auth)
app.use('/api', webhookRouter);
// Google OAuth callback is public: Google redirects the user's browser back
// here, and we re-derive the user from the signed `state` param (see
// routes/googleIntegrations.js). Everything else under /google-integrations is
// auth-required and mounted further down.
app.use('/api', googleIntegrationsPublicRouter);
// White-label: public login-branding lookup (?w=<reseller-slug>) — no auth.
const { publicRouter: whiteLabelPublicRouter } = require('./routes/whiteLabel');
app.use('/api', whiteLabelPublicRouter);
// MCP API — authenticates via its OWN bearer middleware (not the JWT cookie)
app.use('/api/mcp/v1', mcpApiRouter);
// Automation inbound-webhook triggers — public; authenticated by the
// per-automation secret in the URL (see routes/hooks.js).
app.use('/api', require('./routes/hooks').publicRouter);
// Remote (Streamable HTTP) MCP connector — key in the URL path, public.
app.all('/api/mcp/http/:key', mcpHttpHandler);

// Auth routes (public)
app.use('/api', authRouter);

// SaaS tenant context: for every authenticated /api request, resolve the
// tenant + active organization and attach them to req (req.tenantId,
// req.organizationId, req.isSuperAdmin). Non-blocking in Phase 1 — it only
// augments the request; the per-router authMiddleware below still runs and
// remains the source of truth for authentication. See ARCHITECTURE.md.
const { tenantContext } = require('./middleware/tenantContext');
app.use('/api', authMiddleware, tenantContext);

// SaaS Phase 4: feature gating. featureGate(key) 403s when the tenant's plan
// lacks the feature (super admins bypass; no-tenant context is a no-op). These
// are PATH-SCOPED to each premium feature's URL prefixes so the gate only runs
// for those routes — NOT a blanket /api middleware (which would leak to every
// later route). authMiddleware + tenantContext already ran globally above, so
// req.tenantId is resolved by the time these run.
const { featureGate } = require('./services/entitlements');
app.use('/api/broadcasts', featureGate('campaigns'));
app.use(['/api/chatbots', '/api/executions'], featureGate('automations'));
app.use(['/api/agents', '/api/agent-conversation'], featureGate('ai_agents'));

// Protected routes
app.use('/api', authMiddleware, messagesRouter);
app.use('/api', authMiddleware, categoriesRouter);
app.use('/api', authMiddleware, contactFieldsRouter);
app.use('/api', authMiddleware, usersRouter);
app.use('/api', authMiddleware, uploadsRouter);
app.use('/api', authMiddleware, templatesRouter);
app.use('/api', authMiddleware, broadcastsRouter);
app.use('/api', authMiddleware, chatbotsRouter);
app.use('/api', authMiddleware, mediaRouter);
app.use('/api', authMiddleware, mediaLibraryRouter);
app.use('/api', authMiddleware, whatsappAccountsRouter);
app.use('/api', authMiddleware, googleIntegrationsRouter);
app.use('/api', authMiddleware, agentsRouter);
app.use('/api', authMiddleware, agentConversationRouter);
app.use('/api', authMiddleware, mcpAdminRouter);
app.use('/api', authMiddleware, aiModelsRouter);
app.use('/api', authMiddleware, eventsRouter);
app.use('/api', authMiddleware, dashboardRouter);
app.use('/api', authMiddleware, pipelinesRouter);
app.use('/api', authMiddleware, require('./routes/tasks').router);
app.use('/api', authMiddleware, require('./routes/sequences').router);

// Platform (Super Admin) API — internally gated to super admins (requireSuperAdmin).
// tenantContext (mounted above) has already resolved req.isSuperAdmin.
const platformRouter = require('./routes/platform');
app.use('/api', authMiddleware, platformRouter);

// Organizations API — tenant-scoped, gated per-route by requirePerm.
const organizationsRouter = require('./routes/organizations');
app.use('/api', authMiddleware, organizationsRouter);

// Impersonation (start = super admin; stop = the impersonated session).
const impersonationRouter = require('./routes/impersonation');
app.use('/api', authMiddleware, impersonationRouter);

// Billing / entitlements (read-only) — powers the frontend feature-gating UX.
const billingRouter = require('./routes/billing');
app.use('/api', authMiddleware, billingRouter);

// Tenant audit log (audit.view) + white-label branding.
app.use('/api', authMiddleware, require('./routes/audit'));
app.use('/api', authMiddleware, require('./routes/branding'));

// Error handler
app.use((err, req, res, next) => {
  // Full error (with stack) in dev for debugging; message-only in production.
  if (process.env.NODE_ENV !== 'production') console.error('[Error]', err);
  else console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
async function start() {
  // Security posture warning: without META_APP_SECRET the inbound WhatsApp webhook
  // cannot verify Meta's HMAC signature, so payloads are forgeable (anyone who
  // knows the URL could inject fake messages / trigger automations). We do NOT
  // hard-block here because rejecting unverifiable webhooks when the secret is
  // simply unset would drop all real inbound messages — set the secret to close
  // the gap; once set, routes/webhook.js already rejects bad signatures.
  if (process.env.NODE_ENV === 'production' && !process.env.META_APP_SECRET) {
    console.warn(
      '[security] META_APP_SECRET is NOT set — inbound WhatsApp webhooks are accepted ' +
      'WITHOUT signature verification and can be forged. Add META_APP_SECRET (Meta App ' +
      'dashboard → App Secret) to your .env to enable verification.'
    );
  }

  // Apply any pending SQL migrations before touching the schema or serving.
  await require('./db/migrate').runMigrations(pool);
  await ensureTables();
  // Seed the platform super admin if SUPER_ADMIN_EMAIL/PASSWORD are set (opt-in,
  // idempotent). Must run after migrations (needs the super_admin system role).
  await require('./services/superAdminSeed').seedSuperAdmin(pool);
  // Attach any tenant-less, non-super-admin user (e.g. the first admin created
  // by the setup wizard after migrations) to the default tenant. Idempotent.
  await require('./services/tenantBootstrap').attachOrphanUsers(pool);
  await ensureMcpTables().catch(err =>
    console.error('[mcp] table ensure failed (apply migration 057):', err.message)
  );
  mediaStorage.ensureBucket().catch(err =>
    console.error('[media-storage] table ensure failed (will retry on first upload):', err.message)
  );
  startMediaWorker();
  startSendWorker();
  startAgentWorker();
  // Follow-up sequences: every 60s send the next due step of active enrollments.
  require('./services/sequences').startSequenceSweeper();

  // Subscription expiry: keep billing status in sync (active→past_due at period
  // end, →suspended once the grace window is exhausted). Feature locking itself
  // is date-driven in entitlements.js; this only updates the stored status for
  // the Super Admin console. Sweep on boot, then hourly.
  const { sweepExpiredSubscriptions } = require('./services/subscriptionSweeper');
  const runSubscriptionSweep = () =>
    sweepExpiredSubscriptions(pool)
      .then(({ pastDue, suspended }) => {
        if (pastDue || suspended) {
          console.log(`[subscriptions] sweep: ${pastDue} past_due, ${suspended} suspended`);
        }
      })
      .catch(err => console.error('[subscriptions] sweep error:', err.message));
  runSubscriptionSweep();
  setInterval(runSubscriptionSweep, 60 * 60 * 1000).unref();

  // Self-healing delivery/read ticks: re-derive each outbound message's true
  // status from the stored webhook receipts and upgrade any chat_history row
  // that's behind (monotonic). On boot we sweep a wider 7-day window to backfill
  // anything missed while the process was down; then every 60s a cheap 2-day pass.
  reconcileMessageStatuses({ windowDays: 7 })
    .then(n => { if (n > 0) console.log(`[status-reconcile] boot: fixed ${n} tick(s)`); })
    .catch(err => console.error('[status-reconcile] boot error:', err.message));
  setInterval(async () => {
    try {
      const n = await reconcileMessageStatuses({ windowDays: 2 });
      if (n > 0) console.log(`[status-reconcile] fixed ${n} tick(s)`);
    } catch (err) {
      console.error('[status-reconcile] error:', err.message);
    }
  }, 60 * 1000).unref();

  // Stale-pause sweeper: mark paused automation executions that have outlived
  // their expires_at as error. Resume already inline-checks expires_at, so
  // this is purely hygiene against forever-paused rows accumulating.
  setInterval(async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Paused execution expired (no reply within timeout)',
                completed_at=NOW()
          WHERE status='paused' AND expires_at < NOW()`
      );
      if (rowCount > 0) console.log(`[sweeper] expired ${rowCount} paused execution(s)`);

      // Reap orphaned 'running' executions: the engine runs synchronously and
      // finishes in ms, so anything 'running' for >15m means the process died
      // mid-walk (e.g. a restart) and the status was never updated to error.
      const { rowCount: orphans } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Execution interrupted (no completion within 15 minutes)',
                completed_at=NOW()
          WHERE status='running' AND started_at < NOW() - INTERVAL '15 minutes'`
      );
      if (orphans > 0) console.log(`[sweeper] reaped ${orphans} orphaned running execution(s)`);
    } catch (err) {
      console.error('[sweeper] error:', err.message);
    }
  }, 30 * 60 * 1000).unref();

  // Agent close-summary sweeper: when an idle-summary agent's conversation goes
  // quiet (no new message for its idle window) and no human has taken over, ask
  // the agent to write its final summary to the sheet/CRM. Every 2 min.
  const { sweepClosedConversations } = require('./services/agentCloseSummary');
  setInterval(() => {
    sweepClosedConversations()
      .then(n => { if (n > 0) console.log(`[closeSummary] summarised ${n} closed conversation(s)`); })
      .catch(err => console.error('[closeSummary] sweep error:', err.message));
  }, 2 * 60 * 1000).unref();

  // Template status auto-sync: Meta does NOT push template approval/rejection
  // status — we must poll. The tick fires every 10 min but only calls Meta while
  // at least one template is still awaiting review (status='SUBMITTED'). Once all
  // are resolved (approved/rejected/etc.) it idles with zero Meta calls, and
  // auto-resumes when a new template is submitted. Override interval with
  // TEMPLATE_SYNC_INTERVAL_MS.
  const TEMPLATE_SYNC_MS = parseInt(process.env.TEMPLATE_SYNC_INTERVAL_MS || '', 10) || 10 * 60 * 1000;
  const runTemplateSync = async () => {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS pending FROM coexistence.message_templates WHERE status = 'SUBMITTED'`
      );
      const pending = rows[0]?.pending || 0;
      if (pending === 0) return; // all resolved → skip Meta entirely (idle)
      const r = await syncAllAccountTemplates();
      if (r.totalUpdated > 0) {
        console.log(`[template-sync] ${pending} pending → updated ${r.totalUpdated} template(s)`);
      }
    } catch (err) {
      console.error('[template-sync] error:', err.message);
    }
  };
  setTimeout(runTemplateSync, 60 * 1000).unref();        // initial catch-up ~1 min after startup
  setInterval(runTemplateSync, TEMPLATE_SYNC_MS).unref(); // every 10 min (gated by pending count)

  const server = app.listen(PORT, () => {
    console.log(`[Zen Chat] Backend running on port ${PORT}`);
  });

  // Graceful shutdown: stop accepting new connections, drain in-flight HTTP,
  // close the queues (so BullMQ marks in-flight jobs stalled, not lost), then end
  // the DB pool. A hard 15s timeout guards against a hung connection blocking the
  // SIGTERM→SIGKILL window on rolling deploys.
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Zen Chat] ${sig} received, draining…`);
    const hardExit = setTimeout(() => {
      console.warn('[Zen Chat] drain timed out — forcing exit');
      process.exit(0);
    }, 15000);
    hardExit.unref();
    try {
      await new Promise((resolve) => server.close(resolve)); // stop new conns, drain existing
      await shutdownMediaQueue();
      await shutdownSendQueue();
      await shutdownAgentQueue();
      await pool.end().catch(() => {});
    } catch (err) {
      console.error('[Zen Chat] shutdown error:', err.message);
    }
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch(err => {
  console.error('[Fatal] Failed to start:', err.message);
  process.exit(1);
});
