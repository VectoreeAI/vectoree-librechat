const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  createVectoreeAppAuth,
  createVectoreeLink,
  getBalanceConfig,
  isEmailDomainAllowed,
  linkVectoreeUser,
  preAuthTenantMiddleware,
  toVectoreeLinkedUser,
} = require('@librechat/api');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { getAppConfig, invalidateConfigCaches } = require('~/server/services/Config');
const { setAuthTokens } = require('~/server/services/AuthService');
const { findUser, createUser, updateUser, getUserById } = require('~/models');
const middleware = require('~/server/middleware');

if (typeof createVectoreeLink !== 'function' || typeof createVectoreeAppAuth !== 'function') {
  throw new Error(
    'Vectoree helpers are missing from @librechat/api. Rebuild packages/api before starting.',
  );
}

const link = createVectoreeLink({
  env: process.env,
  projectRoot: process.cwd(),
  onLinked: () => invalidateConfigCaches(),
  logger: {
    error: (message) => logger.error(message),
  },
});

const appAuth = createVectoreeAppAuth({
  credentials: () => link.appCredentials(),
});

const router = express.Router();

function publicOrigin(req) {
  const domain = typeof process.env.DOMAIN_SERVER === 'string' ? process.env.DOMAIN_SERVER.trim() : '';
  if (domain) return domain;
  const forwardedProto = req.get('x-forwarded-proto');
  const proto =
    (typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim()) || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function sendError(res, error) {
  const status = error && (error.status === 400 || error.status === 502) ? error.status : 500;
  const message =
    status === 500 || typeof error?.message !== 'string' ? 'Could not connect Vectoree' : error.message;
  res.status(status).json({ status: 'error', message });
}

router.get('/link-status', (_req, res) => {
  try {
    res.json(link.linkStatus());
  } catch {
    logger.error('[vectoree-link] status failed');
    res.status(200).json({ linked: false });
  }
});

/** Relinking swaps the sign-in authority for every account, so it needs an admin. */
function requireAdminToRelink(req, res, next) {
  let linked = true;
  try {
    linked = link.linkStatus().linked === true;
  } catch {
    logger.error('[vectoree-link] status failed before relink check');
  }
  if (!linked) {
    return next();
  }
  return middleware.requireJwtAuth(req, res, () => middleware.checkAdmin(req, res, next));
}

router.post('/link/start', requireAdminToRelink, (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    res.json(
      link.start({
        apiUrl: typeof body.apiUrl === 'string' ? body.apiUrl : undefined,
        projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
        publicOrigin: publicOrigin(req),
      }),
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/link', (_req, res) => {
  res.json(link.poll());
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    username: user.username,
    avatar: user.avatar,
    provider: user.provider,
    role: user.role,
    emailVerified: user.emailVerified,
  };
}

function createdUserId(created) {
  if (created && typeof created === 'object') {
    return String(created._id || created);
  }
  return String(created);
}

router.post(
  '/app-auth',
  preAuthTenantMiddleware,
  middleware.requireSameOrigin,
  middleware.loginLimiter,
  middleware.checkBan,
  async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const outcome = await appAuth.submit({
        action: body.action,
        email: body.email,
        password: body.password,
        otp: body.otp,
      });
      if (outcome.kind === 'response') {
        return res.status(outcome.status).json(outcome.body);
      }

      const config = await getAppConfig({ baseOnly: true });
      const linked = await linkVectoreeUser(outcome.user, outcome.issuer, {
        findByIdentity: async (openidId, issuer) =>
          toVectoreeLinkedUser(
            await findUser({ openidId, openidIssuer: issuer, provider: 'vectoree' }),
          ),
        findByEmail: async (email) => toVectoreeLinkedUser(await findUser({ email })),
        allowEmail: (email) => isEmailDomainAllowed(email, config?.registration?.allowedDomains),
        createUser: async (input) => {
          const created = await createUser(input, getBalanceConfig(config));
          const user = toVectoreeLinkedUser(await getUserById(createdUserId(created)));
          if (!user) {
            throw new Error('Could not create user');
          }
          return user;
        },
        updateUser: async (id, patch) => {
          await updateUser(id, patch);
        },
      });
      if (!linked.ok) {
        return res.status(linked.status).json({ message: linked.message });
      }
      if (linked.user.twoFactorEnabled) {
        return res.status(200).json({
          twoFAPending: true,
          tempToken: generate2FATempToken(linked.user.id),
        });
      }

      const token = await setAuthTokens(linked.user.id, res, null, req);
      return res.status(200).json({ token, user: publicUser(linked.user) });
    } catch {
      logger.error('[vectoree-app-auth] sign-in failed');
      return res.status(500).json({ message: 'Could not sign in' });
    }
  },
);

router.get('/link/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const html = await link.callback({ code, state });
  res.type('html').send(html);
});

module.exports = router;
