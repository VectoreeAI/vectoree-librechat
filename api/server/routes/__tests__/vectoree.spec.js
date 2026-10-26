const express = require('express');
const request = require('supertest');

const mockLink = {
  linkStatus: jest.fn(),
  start: jest.fn(),
  poll: jest.fn(),
  callback: jest.fn(),
  appCredentials: jest.fn(),
};

const mockUsesProjectLink = jest.fn(() => true);
const mockAppAuth = {
  submit: jest.fn(),
  start: jest.fn(),
  setPassword: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  createVectoreeLink: () => mockLink,
  createVectoreeAppAuth: () => mockAppAuth,
  configuredPublicOrigin: jest.fn(() => null),
  confirmCloudPreview: jest.fn(),
  declineCloudPreview: jest.fn(),
  getBalanceConfig: jest.fn(),
  isEmailDomainAllowed: jest.fn(),
  linkVectoreeUser: jest.fn(),
  bindPreviewOwner: jest.fn(),
  previewActive: jest.fn(() => false),
  preAuthTenantMiddleware: (req, res, next) => next(),
  publicDeploymentStatus: (_env, linked) => ({ ...linked, deployMode: 'local', previewed: false }),
  redeemCloudPreview: jest.fn(),
  toVectoreeLinkedUser: jest.fn(),
  usesProjectLink: mockUsesProjectLink,
}));

jest.mock('~/server/services/twoFactorService', () => ({ generate2FATempToken: jest.fn() }));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(),
  invalidateConfigCaches: jest.fn(),
}));
jest.mock('~/server/services/AuthService', () => ({ setAuthTokens: jest.fn() }));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  createUser: jest.fn(),
  updateUser: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('~/server/middleware', () => {
  const pass = (req, res, next) => next();
  return {
    requireSameOrigin: pass,
    loginLimiter: pass,
    previewLimiter: pass,
    checkBan: pass,
    requireJwtAuth: (req, res, next) => {
      const role = req.get('x-test-role');
      if (!role) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      req.user = {
        id: 'user-1',
        role,
        provider: req.get('x-test-provider') || 'local',
        email: req.get('x-test-email') || undefined,
      };
      next();
    },
    checkAdmin: jest.requireActual('~/server/middleware/roles/admin'),
  };
});

describe('Vectoree link routes', () => {
  let app;
  const body = { projectId: '00000000-0000-0000-0000-000000000000' };

  beforeAll(() => {
    const router = require('../vectoree');
    app = express();
    app.use(express.json());
    app.use('/api/vectoree', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUsesProjectLink.mockReturnValue(true);
    mockLink.start.mockReturnValue({ status: 'pending' });
  });

  it('lets anyone start the first link', async () => {
    mockLink.linkStatus.mockReturnValue({ linked: false });

    const response = await request(app).post('/api/vectoree/link/start').send(body);

    expect(response.status).toBe(200);
    expect(mockLink.start).toHaveBeenCalledTimes(1);
  });

  it('rejects an anonymous relink once linked', async () => {
    mockLink.linkStatus.mockReturnValue({ linked: true });

    const response = await request(app).post('/api/vectoree/link/start').send(body);

    expect(response.status).toBe(401);
    expect(mockLink.start).not.toHaveBeenCalled();
  });

  it('rejects a relink by a non-admin user', async () => {
    mockLink.linkStatus.mockReturnValue({ linked: true });

    const response = await request(app)
      .post('/api/vectoree/link/start')
      .set('x-test-role', 'USER')
      .send(body);

    expect(response.status).toBe(403);
    expect(mockLink.start).not.toHaveBeenCalled();
  });

  it('allows an admin to relink', async () => {
    mockLink.linkStatus.mockReturnValue({ linked: true });

    const response = await request(app)
      .post('/api/vectoree/link/start')
      .set('x-test-role', 'ADMIN')
      .send(body);

    expect(response.status).toBe(200);
    expect(mockLink.start).toHaveBeenCalledTimes(1);
  });

  it('does not start a link when DEPLOY_MODE is cloud', async () => {
    mockUsesProjectLink.mockReturnValue(false);

    const response = await request(app).post('/api/vectoree/link/start').send(body);

    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Link is not used when DEPLOY_MODE=cloud');
    expect(mockLink.start).not.toHaveBeenCalled();
  });

  it('sets a password for the signed-in vectoree email', async () => {
    mockAppAuth.setPassword.mockResolvedValue({
      kind: 'response',
      status: 200,
      body: { codeSent: true },
    });

    const response = await request(app)
      .post('/api/vectoree/account/password')
      .set('x-test-role', 'USER')
      .set('x-test-provider', 'vectoree')
      .set('x-test-email', 'ada@example.com')
      .send({
        email: 'other@example.com',
        password: 'long-secret',
        confirmPassword: 'long-secret',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ codeSent: true });
    expect(mockAppAuth.setPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'long-secret',
      confirmPassword: 'long-secret',
      code: undefined,
    });
  });

  it('refuses a password change for a non-vectoree account', async () => {
    const response = await request(app)
      .post('/api/vectoree/account/password')
      .set('x-test-role', 'USER')
      .send({ password: 'long-secret', confirmPassword: 'long-secret' });

    expect(response.status).toBe(403);
    expect(mockAppAuth.setPassword).not.toHaveBeenCalled();
  });

  it('fails closed when the link status cannot be read', async () => {
    mockLink.linkStatus.mockImplementation(() => {
      throw new Error('disk error');
    });

    const response = await request(app).post('/api/vectoree/link/start').send(body);

    expect(response.status).toBe(401);
    expect(mockLink.start).not.toHaveBeenCalled();
  });
});
