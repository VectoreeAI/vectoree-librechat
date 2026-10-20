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

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  createVectoreeLink: () => mockLink,
  createVectoreeAppAuth: () => ({ submit: jest.fn() }),
  getBalanceConfig: jest.fn(),
  isEmailDomainAllowed: jest.fn(),
  linkVectoreeUser: jest.fn(),
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
      req.user = { id: 'user-1', role };
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

  it('fails closed when the link status cannot be read', async () => {
    mockLink.linkStatus.mockImplementation(() => {
      throw new Error('disk error');
    });

    const response = await request(app).post('/api/vectoree/link/start').send(body);

    expect(response.status).toBe(401);
    expect(mockLink.start).not.toHaveBeenCalled();
  });
});
