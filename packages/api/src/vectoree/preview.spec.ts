import type { VectoreeFetch } from './url';
import {
  assertCloudPreview,
  bindPreviewOwner,
  bindRequestPreview,
  clearPreviews,
  confirmCloudPreview,
  currentVectoreeApiKey,
  declineCloudPreview,
  dropPreviewSession,
  previewActive,
  publicCookiePath,
  redeemCloudPreview,
} from './preview';
import { readDeployMode, usesProjectLink } from './mode';
import { readVectoreeAppCredentials } from './link';

const TICKET = 't'.repeat(32);
const PREVIEW_KEY = 'sk-ve-v1-preview-secret';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('cloud preview', () => {
  afterEach(() => {
    clearPreviews();
  });

  test('reads local when DEPLOY_MODE is empty and cloud only for that exact value', () => {
    expect(readDeployMode({})).toBe('local');
    expect(readDeployMode({ DEPLOY_MODE: 'local' })).toBe('local');
    expect(readDeployMode({ DEPLOY_MODE: 'cloud' })).toBe('cloud');
    expect(usesProjectLink({ DEPLOY_MODE: 'cloud' })).toBe(false);
    expect(() => readDeployMode({ DEPLOY_MODE: 'Cloud' })).toThrow(/local or cloud/);
  });

  test('uses the domain path as the preview cookie path', () => {
    expect(publicCookiePath({})).toBe('/');
    expect(publicCookiePath({ DOMAIN_CLIENT: 'https://vectoree.net/librechat/' })).toBe('/librechat');
  });

  test('redeems a ticket once, hides the key, and keeps the same project', async () => {
    const calls: string[] = [];
    const fetchImpl: VectoreeFetch = async (url) => {
      calls.push(url);
      return jsonResponse({ apiKey: PREVIEW_KEY, projectId: 'proj-a', organizationId: 'org-1' });
    };
    const env = {
      DEPLOY_MODE: 'cloud',
      VECTOREE_API_URL: 'https://vectoree.net/',
      VECTOREE_API_KEY: 'sk-ve-server',
      DOMAIN_CLIENT: 'https://vectoree.net/librechat',
    };

    const first = await redeemCloudPreview({ env, ticket: TICKET, secure: true, fetchImpl });
    const cookie = `${first.cookie?.name}=${first.cookie?.value}`;
    const second = await redeemCloudPreview({
      env,
      ticket: TICKET,
      cookieHeader: cookie,
      secure: true,
      fetchImpl,
    });

    expect(calls).toEqual([
      'https://vectoree.net/api/system/starter/preview/redeem',
      'https://vectoree.net/api/system/starter/preview/redeem',
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ projectId: 'proj-a', projectName: 'proj-a' });
    expect(JSON.stringify(first.body)).not.toContain('sk-ve-');
    expect(first.cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/librechat' });
    expect(second.cookie).toBeUndefined();
    expect(second.body.confirm).toBeUndefined();
    expect(previewActive(cookie)).toBe(true);

    let seen: { apiUrl: string; apiKey: string; projectId?: string } | null = null;
    bindRequestPreview(cookie, () => {
      seen = readVectoreeAppCredentials(env, '/tmp');
    });
    expect(seen).toEqual({ apiUrl: 'https://vectoree.net', apiKey: PREVIEW_KEY, projectId: 'proj-a' });
    expect(readVectoreeAppCredentials(env, '/tmp')).toBeNull();
  });

  test('cloud model key is the visitor preview and never the shared environment key', async () => {
    const savedMode = process.env.DEPLOY_MODE;
    const savedKey = process.env.VECTOREE_API_KEY;
    const savedUrl = process.env.VECTOREE_API_URL;
    process.env.DEPLOY_MODE = 'cloud';
    process.env.VECTOREE_API_KEY = 'sk-ve-shared';
    process.env.VECTOREE_API_URL = 'https://vectoree.net';
    try {
      expect(currentVectoreeApiKey()).toBe('');
      const redeemed = await redeemCloudPreview({
        env: process.env,
        ticket: TICKET,
        secure: false,
        fetchImpl: async () => jsonResponse({ apiKey: PREVIEW_KEY, projectId: 'proj-a' }),
      });
      const cookie = `${redeemed.cookie?.name}=${redeemed.cookie?.value}`;
      let seen = '';
      bindRequestPreview(cookie, () => {
        seen = currentVectoreeApiKey() ?? '';
      });
      expect(seen).toBe(PREVIEW_KEY);
      expect(currentVectoreeApiKey()).toBe('');
    } finally {
      restoreEnv('DEPLOY_MODE', savedMode);
      restoreEnv('VECTOREE_API_KEY', savedKey);
      restoreEnv('VECTOREE_API_URL', savedUrl);
    }
  });

  test('asks before replacing a preview from a different project', async () => {
    let projectId = 'proj-a';
    const fetchImpl: VectoreeFetch = async () =>
      jsonResponse({ apiKey: PREVIEW_KEY, projectId, organizationId: 'org-1' });
    const env = { DEPLOY_MODE: 'cloud', VECTOREE_API_URL: 'https://vectoree.net', VECTOREE_API_KEY: 'sk-ve-server' };
    const first = await redeemCloudPreview({ env, ticket: TICKET, secure: true, fetchImpl });
    const cookie = `${first.cookie?.name}=${first.cookie?.value}`;
    expect(bindPreviewOwner(cookie, 'user-a')).toBe(true);
    projectId = 'proj-b';
    const second = await redeemCloudPreview({
      env,
      ticket: TICKET,
      cookieHeader: cookie,
      secure: true,
      fetchImpl,
    });

    expect(second.body).toMatchObject({ projectId: 'proj-b', confirm: true });
    expect(second.cookie).toBeUndefined();
    expect(second.body.switchToken).toBeUndefined();
    expect(second.cookies?.[0]?.name).toBe('ve_preview_switch');
    expect(JSON.stringify(second.body)).not.toContain('sk-ve-');
    expect(previewActive(cookie)).toBe(true);
    const switchCookie = `${second.cookies?.[0]?.name}=${second.cookies?.[0]?.value}`;
    expect(previewActive(switchCookie)).toBe(false);
    expect(assertCloudPreview(env, cookie, { openidId: 'user-a', provider: 'vectoree' })).toBeNull();
    expect(assertCloudPreview(env, cookie, { openidId: 'user-b', provider: 'vectoree' })?.message).toMatch(/Sign in again/);

    const declined = declineCloudPreview(env, undefined, `${cookie}; ${switchCookie}`, true);
    expect(declined.status).toBe(200);
    expect(previewActive(cookie)).toBe(true);

    projectId = 'proj-c';
    const third = await redeemCloudPreview({
      env,
      ticket: TICKET,
      cookieHeader: cookie,
      secure: false,
      fetchImpl,
    });
    const pendingSwitch = `${third.cookies?.[0]?.name}=${third.cookies?.[0]?.value}`;
    // Stolen switch cookie alone must not confirm in another browser (no ve_preview).
    const stolen = confirmCloudPreview({
      env,
      cookieHeader: pendingSwitch,
      secure: true,
    });
    expect(stolen.status).toBe(401);
    const confirmed = confirmCloudPreview({
      env,
      cookieHeader: `${cookie}; ${pendingSwitch}`,
      secure: true,
    });
    const nextCookie = `${confirmed.cookie?.name}=${confirmed.cookie?.value}`;
    expect(confirmed.status).toBe(200);
    expect(previewActive(cookie)).toBe(false);
    expect(previewActive(nextCookie)).toBe(true);
    expect(assertCloudPreview(env, nextCookie, { openidId: 'user-a', provider: 'vectoree' })?.message).toMatch(
      /Sign in again/,
    );
    expect(bindPreviewOwner(nextCookie, 'user-c')).toBe(true);
    expect(assertCloudPreview(env, nextCookie, { openidId: 'user-c', provider: 'vectoree' })).toBeNull();
    dropPreviewSession(nextCookie);
    expect(previewActive(nextCookie)).toBe(false);
    expect(assertCloudPreview(env, nextCookie, { openidId: 'user-c', provider: 'vectoree' })?.message).toMatch(
      /expired/,
    );
  });

  test('does not call Vectoree for a local deploy or a malformed ticket', async () => {
    const fetchImpl: VectoreeFetch = async () => {
      throw new Error('should not be called');
    };
    const local = await redeemCloudPreview({
      env: { DEPLOY_MODE: 'local' },
      ticket: TICKET,
      secure: false,
      fetchImpl,
    });
    const bad = await redeemCloudPreview({
      env: { DEPLOY_MODE: 'cloud' },
      ticket: 'short',
      secure: false,
      fetchImpl,
    });
    expect(local.status).toBe(404);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('preview_required');
  });

  test('maps a rejected ticket to preview_required and a network failure to 502', async () => {
    const rejected = await redeemCloudPreview({
      env: { DEPLOY_MODE: 'cloud', VECTOREE_API_URL: 'https://vectoree.net' },
      ticket: TICKET,
      secure: true,
      fetchImpl: async () => jsonResponse({ message: 'used' }, 410),
    });
    const down = await redeemCloudPreview({
      env: { DEPLOY_MODE: 'cloud', VECTOREE_API_URL: 'https://vectoree.net' },
      ticket: TICKET,
      secure: true,
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(rejected.status).toBe(401);
    expect(rejected.cookie).toBeUndefined();
    expect(down.status).toBe(502);
    expect(down.body.message).toContain('https://vectoree.net');
  });
});
