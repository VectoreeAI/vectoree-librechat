import type { VectoreeFetch } from './url';
import {
  bindRequestPreview,
  clearPreviews,
  previewActive,
  publicCookiePath,
  redeemCloudPreview,
} from './preview';
import { readDeployMode, usesProjectLink } from './mode';
import { readVectoreeAppCredentials } from './link';

const TICKET = 't'.repeat(32);
const PREVIEW_KEY = 'sk-ve-v1-preview-secret';

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

  test('redeems a ticket once, hides the key, and replaces the previous preview', async () => {
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
    const second = await redeemCloudPreview({
      env,
      ticket: TICKET,
      cookieHeader: `${first.cookie?.name}=${first.cookie?.value}`,
      secure: true,
      fetchImpl,
    });

    expect(calls).toEqual([
      'https://vectoree.net/api/system/starter/preview/redeem',
      'https://vectoree.net/api/system/starter/preview/redeem',
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ projectId: 'proj-a' });
    expect(JSON.stringify(first.body)).not.toContain('sk-ve-');
    expect(first.cookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/librechat' });
    expect(previewActive(`${first.cookie?.name}=${first.cookie?.value}`)).toBe(false);
    expect(previewActive(`${second.cookie?.name}=${second.cookie?.value}`)).toBe(true);

    let seen: { apiUrl: string; apiKey: string } | null = null;
    bindRequestPreview(`${second.cookie?.name}=${second.cookie?.value}`, () => {
      seen = readVectoreeAppCredentials(env, '/tmp');
    });
    expect(seen).toEqual({ apiUrl: 'https://vectoree.net', apiKey: PREVIEW_KEY });
    expect(readVectoreeAppCredentials(env, '/tmp')).toBeNull();
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
