import type { VectoreeLinkedUser } from './appAuth';
import { createVectoreeAppAuth, linkVectoreeUser, previewIssuer, toVectoreeLinkedUser } from './appAuth';

const API = 'https://vectoree.ai';
const KEY = 'sk-ve-v1-test-key';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function credentials() {
  return { apiUrl: API, apiKey: KEY };
}

describe('vectoree app auth', () => {
  test('cloud identities include the project so user ids cannot collide', () => {
    const projectId = '11111111-2222-4333-8444-555555555555';
    expect(previewIssuer({ DEPLOY_MODE: 'cloud' }, { apiUrl: API, apiKey: KEY, projectId })).toBe(
      `${API}/projects/${projectId}`,
    );
    expect(previewIssuer({ DEPLOY_MODE: 'local' }, { apiUrl: API, apiKey: KEY, projectId })).toBe(API);
    expect(previewIssuer({}, { apiUrl: API, apiKey: KEY })).toBe(API);
  });

  test('register that still needs a code does not send a second email', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ requireEmailVerification: true, user: { id: 'u1', email: 'a@example.com' } }),
    );
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.submit({
      action: 'register',
      email: 'A@Example.com',
      password: 'secret1',
    });
    expect(outcome).toEqual({
      kind: 'response',
      status: 200,
      body: { requireEmailVerification: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/auth/users?client_type=server`);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@example.com', password: 'secret1' });
    expect(url).not.toContain('/api/system/auth');
  });

  test('passes a taken email through so the client can try login', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ message: 'exists' }, 409));
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.submit({
      action: 'register',
      email: 'a@example.com',
      password: 'secret1',
    });
    expect(outcome).toEqual({ kind: 'response', status: 409, body: { message: 'exists' } });
  });

  test('treats an unverified login as a code challenge and hides the project key', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ message: `bad ${KEY}`, requireEmailVerification: true }, 403),
    );
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.submit({
      action: 'login',
      email: 'a@example.com',
      password: 'secret1',
    });
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.status).toBe(403);
    expect(outcome.body.requireEmailVerification).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(JSON.stringify(outcome)).not.toContain('accessToken');
  });

  test('returns the app user after the 8-digit code without exposing the token', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        accessToken: 'app-user-jwt',
        user: {
          id: 'user-1',
          email: 'A@Example.com',
          emailVerified: true,
          profile: { name: 'Ada' },
        },
      }),
    );
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.submit({
      action: 'verify',
      email: 'a@example.com',
      otp: '12345678',
    });
    expect(outcome).toEqual({
      kind: 'session',
      issuer: API,
      user: { id: 'user-1', email: 'a@example.com', emailVerified: true, name: 'Ada' },
    });
    expect(JSON.stringify(outcome)).not.toContain('app-user-jwt');
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      email: 'a@example.com',
      otp: '12345678',
    });
  });

  test('rejects a short code and a missing project before calling Vectoree', async () => {
    const fetchImpl = jest.fn();
    const auth = createVectoreeAppAuth({ credentials: () => null, fetchImpl });
    expect(await auth.submit({ action: 'verify', email: 'a@example.com', otp: '1234' })).toEqual({
      kind: 'response',
      status: 400,
      body: { message: 'Enter the 8-digit code' },
    });
    expect(
      await auth.submit({ action: 'login', email: 'a@example.com', password: 'secret1' }),
    ).toEqual({
      kind: 'response',
      status: 400,
      body: { message: 'Vectoree is not connected' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('sends a reset email and exchanges a 6-digit code without starting a session', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('exchange-reset-password-token')) {
        return jsonResponse({ token: 'reset-token', expiresAt: '2026-01-01T00:00:00.000Z' });
      }
      if (String(url).includes('/email/reset-password')) {
        return jsonResponse({ message: 'Password updated' });
      }
      return jsonResponse({ success: true, message: 'sent' }, 202);
    });
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const sent = await auth.submit({
      action: 'send-reset',
      email: 'A@Example.com',
      redirectTo: 'https://chat.example/reset-password',
    });
    expect(sent).toEqual({ kind: 'response', status: 202, body: { ok: true } });
    const exchanged = await auth.submit({
      action: 'exchange-reset',
      email: 'a@example.com',
      code: '123456',
    });
    expect(exchanged).toEqual({
      kind: 'response',
      status: 200,
      body: { resetToken: 'reset-token' },
    });
    const reset = await auth.submit({
      action: 'reset-password',
      password: 'new-secret',
      otp: 'reset-token',
    });
    expect(reset).toEqual({ kind: 'response', status: 200, body: { ok: true } });
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0]).toEqual({
      email: 'a@example.com',
      redirectTo: 'https://chat.example/reset-password',
    });
    expect(bodies[1]).toEqual({ email: 'a@example.com', code: '123456' });
    expect(bodies[2]).toEqual({ newPassword: 'new-secret', otp: 'reset-token' });
  });

  test('rejects an http reset link before calling Vectoree', async () => {
    const fetchImpl = jest.fn();
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    expect(
      await auth.submit({
        action: 'send-reset',
        email: 'a@example.com',
        redirectTo: 'http://evil.example/reset-password',
      }),
    ).toEqual({
      kind: 'response',
      status: 400,
      body: { message: 'Reset link must use https' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('linkVectoreeUser', () => {
  const identity = {
    id: 'user-1',
    email: 'Ada@Example.com',
    emailVerified: true,
    name: 'Ada',
  };

  function deps(users: VectoreeLinkedUser[]) {
    const store = [...users];
    return {
      store,
      findByIdentity: async (openidId: string, _issuer: string) =>
        store.find((user) => user.openidId === openidId && user.provider === 'vectoree') ?? null,
      findByEmail: async (email: string) => store.find((user) => user.email === email) ?? null,
      allowEmail: () => true,
      createUser: async (input: {
        email: string;
        name: string;
        username: string;
        provider: 'vectoree';
        openidId: string;
        openidIssuer: string;
        emailVerified: boolean;
      }) => {
        const created: VectoreeLinkedUser = {
          id: 'local-1',
          email: input.email,
          name: input.name,
          username: input.username,
          provider: input.provider,
          emailVerified: input.emailVerified,
          twoFactorEnabled: false,
          openidId: input.openidId,
        };
        store.push(created);
        return created;
      },
      updateUser: async (id: string, patch: Partial<VectoreeLinkedUser>) => {
        const user = store.find((item) => item.id === id);
        if (user) Object.assign(user, patch);
      },
    };
  }

  test('creates a local user from the Vectoree subject', async () => {
    const gateway = deps([]);
    const result = await linkVectoreeUser(identity, API, gateway);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toMatchObject({
      email: 'ada@example.com',
      provider: 'vectoree',
      openidId: 'user-1',
      name: 'Ada',
      username: 'ada',
      emailVerified: true,
    });
    expect(gateway.store[0]?.openidId).toBe('user-1');
  });

  test('reuses the same Vectoree subject and refuses a local account', async () => {
    const existing = await linkVectoreeUser(identity, API, deps([]));
    if (!existing.ok) throw new Error('expected create');
    const again = await linkVectoreeUser(identity, API, deps([existing.user]));
    expect(again).toMatchObject({ ok: true, user: { id: existing.user.id } });

    const local: VectoreeLinkedUser = {
      id: 'local-9',
      email: 'ada@example.com',
      provider: 'local',
      emailVerified: true,
      twoFactorEnabled: false,
    };
    const blocked = await linkVectoreeUser(identity, API, deps([local]));
    expect(blocked).toEqual({
      ok: false,
      status: 403,
      message: 'An account with this email already uses another sign-in method',
    });
  });

  test('reads a stored user id without keeping secrets', () => {
    expect(
      toVectoreeLinkedUser({
        _id: { toHexString: () => 'abc123' },
        email: 'A@Example.com',
        provider: 'vectoree',
        emailVerified: true,
        password: 'hashed',
        openidId: 'user-1',
      }),
    ).toEqual({
      id: 'abc123',
      email: 'a@example.com',
      provider: 'vectoree',
      emailVerified: true,
      twoFactorEnabled: false,
      openidId: 'user-1',
    });
  });

  test('email start registers a new address and asks for the code', async () => {
    const fetchImpl = jest.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('/api/auth/users')) {
        return jsonResponse({ requireEmailVerification: true }, 200);
      }
      throw new Error(`unexpected ${url}`);
    });
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.start('Ada@Example.com');
    expect(outcome).toEqual({
      kind: 'response',
      status: 200,
      body: { requireEmailVerification: true },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.email).toBe('ada@example.com');
    expect(typeof body.password).toBe('string');
    expect(body.password.length).toBeGreaterThanOrEqual(8);
  });

  test('email start resends a code when the address already exists', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (String(url).includes('/api/auth/users')) {
        return jsonResponse({ code: 'AUTH_EMAIL_EXISTS', message: 'Email already exists' }, 409);
      }
      return jsonResponse({ ok: true }, 200);
    });
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.start('ada@example.com');
    expect(outcome).toEqual({
      kind: 'response',
      status: 200,
      body: { requireEmailVerification: true },
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('/api/auth/email/send-verification');
  });

  test('set password sends a code before it is entered', async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true }, 200),
    );
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.setPassword({
      email: 'ada@example.com',
      password: 'long-secret',
      confirmPassword: 'long-secret',
    });
    expect(outcome).toEqual({ kind: 'response', status: 200, body: { codeSent: true } });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/api/auth/email/send-reset-password');
  });

  test('set password exchanges the code and saves the new password', async () => {
    const fetchImpl = jest.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('exchange-reset-password-token')) {
        return jsonResponse({ token: 'reset-token' }, 200);
      }
      return jsonResponse({ ok: true }, 200);
    });
    const auth = createVectoreeAppAuth({ credentials, fetchImpl });
    const outcome = await auth.setPassword({
      email: 'ada@example.com',
      password: 'long-secret',
      confirmPassword: 'long-secret',
      code: '123456',
    });
    expect(outcome).toEqual({ kind: 'response', status: 200, body: { ok: true } });
    const [, savedInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    const saved = JSON.parse(String(savedInit.body));
    expect(saved).toEqual({ newPassword: 'long-secret', otp: 'reset-token' });
  });
});
