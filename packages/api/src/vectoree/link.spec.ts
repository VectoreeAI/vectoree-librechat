import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractProjectId, normalizeApiUrl } from './url';
import { createVectoreeLink } from './link';
import { upsertEnv } from './envfile';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vectoree-link-'));
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('vectoree link', () => {
  test('extracts a project UUID from a console URL', () => {
    expect(extractProjectId(PROJECT_ID)).toBe(PROJECT_ID);
    expect(extractProjectId(`https://vectoree.ai/dashboard/projects/${PROJECT_ID}`)).toBe(PROJECT_ID);
    expect(extractProjectId(`Dashboard project: Demo (${PROJECT_ID})`)).toBe(PROJECT_ID);
    expect(extractProjectId('not a project')).toBeNull();
  });

  test('rejects an api origin that is not an origin', () => {
    expect(normalizeApiUrl('https://vectoree.ai/')).toBe('https://vectoree.ai');
    expect(() => normalizeApiUrl('https://vectoree.ai/api/v1')).toThrow(/origin/);
    expect(() => normalizeApiUrl('https://user:pass@vectoree.ai')).toThrow(/credentials/);
  });

  test('upserts env keys without dropping comments', () => {
    const next = upsertEnv('# keep\nOPENAI_API_KEY=sk-old\nVECTOREE_API_KEY=old\n', {
      VECTOREE_API_KEY: 'sk-ve-v1-new',
      VECTOREE_API_URL: 'https://vectoree.ai',
    });
    expect(next).toContain('# keep');
    expect(next).toContain('OPENAI_API_KEY=sk-old');
    expect(next).toContain('VECTOREE_API_KEY=sk-ve-v1-new');
    expect(next).toContain('VECTOREE_API_URL=https://vectoree.ai');
  });

  test('treats a missing key as unlinked and an env key as linked', () => {
    const root = tempRoot();
    const unlinked = createVectoreeLink({ env: {}, projectRoot: root, linkDataRoot: root });
    expect(unlinked.linkStatus()).toEqual({ linked: false });

    const env = { VECTOREE_API_KEY: 'sk-ve-v1-from-env', VECTOREE_API_URL: 'https://vectoree.ai' };
    const linked = createVectoreeLink({ env, projectRoot: root, linkDataRoot: root });
    expect(linked.linkStatus()).toEqual({ linked: true, apiUrl: 'https://vectoree.ai' });
    expect(JSON.stringify(linked.linkStatus())).not.toContain('sk-ve-');
    expect(unlinked.appCredentials()).toBeNull();
    expect(linked.appCredentials()).toEqual({
      apiUrl: 'https://vectoree.ai',
      apiKey: 'sk-ve-v1-from-env',
    });
  });

  test('starts a host callback and never returns the verifier', () => {
    const root = tempRoot();
    const link = createVectoreeLink({ env: {}, projectRoot: root, linkDataRoot: root });
    const snapshot = link.start({
      apiUrl: 'https://vectoree.ai',
      projectId: `see ${PROJECT_ID}`,
      publicOrigin: 'http://localhost:3080',
    });
    expect(snapshot.status).toBe('pending');
    expect(snapshot.authorizeUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3080%2Fapi%2Fvectoree%2Flink%2Fcallback');
    expect(snapshot.authorizeUrl).toContain('code_challenge_method=S256');
    expect(snapshot.authorizeUrl).not.toContain('127.0.0.1');
    expect(JSON.stringify(snapshot)).not.toMatch(/verifier|apiKey|accessToken/i);
  });

  test('rejects a project id that is not a UUID and a data root that is not writable', () => {
    const root = tempRoot();
    const link = createVectoreeLink({ env: {}, projectRoot: root, linkDataRoot: root });
    expect(() =>
      link.start({ projectId: 'nope', publicOrigin: 'http://localhost:3080' }),
    ).toThrow(/UUID/);

    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    const blocked = createVectoreeLink({ env: {}, projectRoot: root, linkDataRoot: file });
    expect(() =>
      blocked.start({ projectId: PROJECT_ID, publicOrigin: 'http://localhost:3080' }),
    ).toThrow(/not writable/);
  });

  test('callback validates state, then persists without exposing secrets', async () => {
    const root = tempRoot();
    const projectRoot = tempRoot();
    const env: NodeJS.ProcessEnv = {};
    const onLinked = jest.fn();
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/system/auth/cli/token')) {
        const body = JSON.parse(String(init?.body)) as { redirect_uri?: string; code?: string };
        expect(body.redirect_uri).toBe('http://localhost:3080/api/vectoree/link/callback');
        expect(body.code).toBe('auth-code');
        return response({ accessToken: 'jwt-access', refreshToken: 'jwt-refresh' });
      }
      if (href.endsWith('/api/projects')) {
        return response([{ id: PROJECT_ID, name: 'Demo' }]);
      }
      if (href.endsWith('/api/gateway/keys')) {
        expect(init?.headers).toMatchObject({ 'User-Agent': 'VectoreeCLI', 'X-Project-Id': PROJECT_ID });
        const body = JSON.parse(String(init?.body)) as { scopes?: string[] };
        expect(body.scopes).toEqual([
          'gateway:chat',
          'gateway:models',
          'tools:*',
          'database:*',
          'storage:*',
          'auth:*',
        ]);
        return response({ apiKey: 'sk-ve-v1-minted', id: 'key-1' });
      }
      throw new Error(`unexpected ${href}`);
    });
    const link = createVectoreeLink({
      env,
      projectRoot,
      linkDataRoot: root,
      fetchImpl,
      onLinked,
    });
    const started = link.start({
      projectId: PROJECT_ID,
      publicOrigin: 'http://localhost:3080',
    });
    const state = new URL(started.authorizeUrl ?? '').searchParams.get('state') ?? '';
    const invalid = await link.callback({ code: 'auth-code', state: 'wrong-state-value' });
    expect(invalid).toContain('Invalid');
    expect(link.poll().status).toBe('pending');

    const html = await link.callback({ code: 'auth-code', state });
    expect(html).toContain('Vectoree connected');
    expect(html).not.toContain('sk-ve-');
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(env.VECTOREE_API_KEY).toBe('sk-ve-v1-minted');
    expect(env.VECTOREE_API_BASE).toBe('https://vectoree.ai/api/v1');
    expect(env.VECTOREE_API_URL).toBe('https://vectoree.ai');

    const config = JSON.parse(fs.readFileSync(path.join(root, '.vectoree', 'config.json'), 'utf8')) as {
      apiKey: string;
    };
    expect(config.apiKey).toBe('sk-ve-v1-minted');
    expect(fs.statSync(path.join(root, '.vectoree', 'config.json')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toContain('VECTOREE_API_KEY=sk-ve-v1-minted');
    expect(fs.readFileSync(path.join(root, '.vectoree', 'env'), 'utf8')).toContain(
      'VECTOREE_API_BASE=https://vectoree.ai/api/v1',
    );

    const status = link.linkStatus();
    const poll = link.poll();
    expect(status).toEqual({ linked: true, apiUrl: 'https://vectoree.ai', projectName: 'Demo' });
    expect(poll.status).toBe('linked');
    const serialized = JSON.stringify({ status, poll });
    expect(serialized).not.toContain('sk-ve-');
    expect(serialized).not.toContain('jwt-access');
    expect(serialized).not.toContain('jwt-refresh');
  });

  test('stores the configured https reset origin on the project allowlist', async () => {
    const root = tempRoot();
    const projectRoot = tempRoot();
    const env: NodeJS.ProcessEnv = { DOMAIN_CLIENT: 'https://vectoree.net/librechat/' };
    const puts: unknown[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/api/system/auth/cli/token')) {
        return response({ accessToken: 'jwt-access', refreshToken: 'jwt-refresh' });
      }
      if (href.endsWith('/api/projects')) return response([{ id: PROJECT_ID, name: 'Demo' }]);
      if (href.endsWith('/api/gateway/keys')) return response({ apiKey: 'sk-ve-v1-minted', id: 'key-1' });
      if (href.endsWith('/api/auth/config') && (init?.method ?? 'GET') === 'GET') {
        return response({ allowedRedirectUrls: ['https://existing.example/**'] });
      }
      if (href.endsWith('/api/auth/config') && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)));
        return response({ allowedRedirectUrls: [] });
      }
      throw new Error(`unexpected ${href}`);
    });
    const link = createVectoreeLink({
      env,
      projectRoot,
      linkDataRoot: root,
      fetchImpl,
    });
    const started = link.start({ projectId: PROJECT_ID, publicOrigin: 'http://evil.example' });
    const state = new URL(started.authorizeUrl ?? '').searchParams.get('state') ?? '';
    const html = await link.callback({ code: 'auth-code', state });
    expect(html).toContain('Vectoree connected');
    expect(puts).toEqual([
      {
        allowedRedirectUrls: ['https://existing.example/**', 'https://vectoree.net/librechat/reset-password**'],
      },
    ]);
  });

  test('expires a pending login', async () => {
    let clock = 1_000;
    const root = tempRoot();
    const link = createVectoreeLink({
      env: {},
      projectRoot: root,
      linkDataRoot: root,
      now: () => clock,
      timeoutMs: 50,
    });
    const started = link.start({ projectId: PROJECT_ID, publicOrigin: 'http://localhost:3080' });
    const state = new URL(started.authorizeUrl ?? '').searchParams.get('state') ?? '';
    clock = 2_000;
    const html = await link.callback({ code: 'auth-code', state });
    expect(html).toContain('timed out');
    expect(link.poll().status).toBe('error');
  });

  test('hydrates Vectoree env from the data root and drops only the OpenAI user_provided sentinel', () => {
    const root = tempRoot();
    const projectRoot = tempRoot();
    fs.mkdirSync(path.join(root, '.vectoree'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vectoree', 'config.json'),
      `${JSON.stringify({
        apiUrl: 'https://vectoree.ai',
        apiKey: 'sk-ve-v1-from-disk',
        projectId: PROJECT_ID,
      })}\n`,
    );
    fs.writeFileSync(path.join(projectRoot, '.env'), 'OPENAI_API_KEY=user_provided\nANTHROPIC_API_KEY=user_provided\n');
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'user_provided' };
    const link = createVectoreeLink({ env, projectRoot, linkDataRoot: root });
    expect(env.VECTOREE_API_KEY).toBe('sk-ve-v1-from-disk');
    expect(env.VECTOREE_API_BASE).toBe('https://vectoree.ai/api/v1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toContain('OPENAI_API_KEY=\n');
    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toContain(
      'ANTHROPIC_API_KEY=user_provided',
    );
    expect(link.linkStatus().linked).toBe(true);

    const keptRoot = tempRoot();
    const keptEnv: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-real' };
    fs.writeFileSync(path.join(keptRoot, '.env'), 'OPENAI_API_KEY=sk-real\n');
    createVectoreeLink({ env: keptEnv, projectRoot: keptRoot, linkDataRoot: tempRoot() });
    expect(keptEnv.OPENAI_API_KEY).toBe('sk-real');
  });
});
