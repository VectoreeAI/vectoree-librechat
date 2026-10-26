import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setRuntimeEnvReader } from 'librechat-data-provider';
import type { VectoreeFetch } from './url';
import { DEFAULT_API_URL, normalizeApiUrl } from './url';
import { nonEmpty, readErrorMessage } from './text';
import { readDeployMode } from './mode';

export const PREVIEW_COOKIE = 've_preview';
export const PREVIEW_SWITCH_COOKIE = 've_preview_switch';

const IDLE_MS = 12 * 60 * 60 * 1000;
const PENDING_MS = 2 * 60 * 1000;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REDEEM_PATH = '/api/system/starter/preview/redeem';
const TICKET = /^\S{16,512}$/;
const PREVIEW_ID = /^[a-f0-9]{64}$/;

export type PreviewCredentials = {
  apiUrl: string;
  apiKey: string;
  projectId: string;
};

type StoredPreview = PreviewCredentials & {
  lastUsed: number;
  pending?: boolean;
  ownerId?: string;
  /** Active ve_preview id that must accompany confirm/decline (same browser). */
  fromPreviewId?: string;
};

const previews = new Map<string, StoredPreview>();
const current = new AsyncLocalStorage<PreviewCredentials>();

const sweep = setInterval(() => dropIdlePreviews(Date.now()), 60 * 60 * 1000);
sweep.unref();

export type PreviewCookieOptions = {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
};

export type PreviewCookie = {
  name: string;
  value: string;
  options: PreviewCookieOptions;
};

export type PreviewRedeemResult = {
  status: 200 | 401 | 404 | 502;
  body: {
    projectId?: string;
    projectName?: string;
    confirm?: boolean;
    message?: string;
    code?: 'preview_required';
  };
  cookie?: PreviewCookie;
  /** Additional Set-Cookie values (e.g. pending switch token). */
  cookies?: PreviewCookie[];
};

export type PreviewPrincipal = {
  openidId?: string;
  provider?: string;
};

export function clearPreviews(): void {
  previews.clear();
}

export function dropIdlePreviews(now: number): void {
  for (const [id, stored] of previews) {
    const limit = stored.pending ? PENDING_MS : IDLE_MS;
    if (now - stored.lastUsed > limit) previews.delete(id);
  }
}

export function currentPreviewCredentials(): PreviewCredentials | null {
  return current.getStore() ?? null;
}

export function bindRequestPreview(cookieHeader: string | undefined, next: () => void): void {
  const record = touchPreview(cookieHeader);
  if (!record) {
    next();
    return;
  }
  current.run(record, next);
}

export function previewActive(cookieHeader: string | undefined): boolean {
  return touchPreview(cookieHeader) !== null;
}

export function publicCookiePath(env: NodeJS.ProcessEnv): string {
  const raw = nonEmpty(env.DOMAIN_CLIENT) ?? nonEmpty(env.DOMAIN_SERVER);
  if (!raw) return '/';
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, '');
    return path || '/';
  } catch {
    return '/';
  }
}

export async function redeemCloudPreview(input: {
  env: NodeJS.ProcessEnv;
  ticket: unknown;
  cookieHeader?: string;
  secure: boolean;
  fetchImpl?: VectoreeFetch;
  now?: () => number;
}): Promise<PreviewRedeemResult> {
  if (readDeployMode(input.env) !== 'cloud') {
    return { status: 404, body: { message: 'Not available in local mode' } };
  }
  const ticket = typeof input.ticket === 'string' ? input.ticket.trim() : '';
  if (!TICKET.test(ticket)) {
    return expiredPreview();
  }

  let apiUrl: string;
  try {
    apiUrl = normalizeApiUrl(nonEmpty(input.env.VECTOREE_API_URL) ?? DEFAULT_API_URL);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not reach Vectoree';
    return { status: 502, body: { message } };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${apiUrl}${REDEEM_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { status: 502, body: { message: `Could not reach Vectoree at ${apiUrl}` } };
  }

  const text = await upstream.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = null;
  }
  if (upstream.status >= 400 && upstream.status < 500) return expiredPreview();
  if (!upstream.ok) {
    return {
      status: 502,
      body: {
        message: readErrorMessage(data, `Vectoree could not open the preview (${upstream.status})`),
      },
    };
  }

  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : '';
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
  if (!apiKey.startsWith('sk-ve-') || !projectId) {
    return { status: 502, body: { message: 'Vectoree returned an unexpected preview' } };
  }

  const now = input.now?.() ?? Date.now();
  const projectName = projectId;
  const previousId = cookieValue(input.cookieHeader, PREVIEW_COOKIE);
  const previous = previousId && PREVIEW_ID.test(previousId) ? previews.get(previousId) : undefined;
  if (
    previous &&
    !previous.pending &&
    now - previous.lastUsed <= IDLE_MS &&
    previous.projectId === projectId
  ) {
    previous.apiKey = apiKey;
    previous.apiUrl = apiUrl;
    previous.lastUsed = now;
    return { status: 200, body: { projectId, projectName } };
  }
  if (previous && previousId && !previous.pending && now - previous.lastUsed <= IDLE_MS) {
    const id = randomBytes(32).toString('hex');
    previews.set(id, {
      apiUrl,
      apiKey,
      projectId,
      lastUsed: now,
      pending: true,
      fromPreviewId: previousId,
    });
    return {
      status: 200,
      body: { projectId, projectName, confirm: true },
      cookies: [switchCookie(input.env, input.secure, id)],
    };
  }
  if (previousId && PREVIEW_ID.test(previousId)) previews.delete(previousId);
  const id = randomBytes(32).toString('hex');
  previews.set(id, { apiUrl, apiKey, projectId, lastUsed: now });
  return {
    status: 200,
    body: { projectId, projectName },
    cookie: previewCookie(input.env, input.secure, id),
  };
}

export function confirmCloudPreview(input: {
  env: NodeJS.ProcessEnv;
  cookieHeader?: string;
  secure: boolean;
  now?: () => number;
}): PreviewRedeemResult {
  if (readDeployMode(input.env) !== 'cloud') {
    return { status: 404, body: { message: 'Not available in local mode' } };
  }
  const pending = takePending(
    cookieValue(input.cookieHeader, PREVIEW_SWITCH_COOKIE),
    input.now?.() ?? Date.now(),
  );
  if (!pending) return expiredPreview();
  const previousId = cookieValue(input.cookieHeader, PREVIEW_COOKIE);
  if (!previousId || previousId !== pending.stored.fromPreviewId) {
    return expiredPreview();
  }
  if (previousId !== pending.id) previews.delete(previousId);
  pending.stored.pending = false;
  pending.stored.ownerId = undefined;
  pending.stored.fromPreviewId = undefined;
  return {
    status: 200,
    body: { projectId: pending.stored.projectId, projectName: pending.stored.projectId },
    cookie: previewCookie(input.env, input.secure, pending.id),
    cookies: [clearSwitchCookie(input.env, input.secure)],
  };
}

/** Only the browser that opened the preview can drop its own pending switch. */
export function declineCloudPreview(
  env: NodeJS.ProcessEnv,
  cookieHeader?: string,
  secure = false,
  now = Date.now(),
): PreviewRedeemResult {
  if (readDeployMode(env) !== 'cloud') {
    return { status: 404, body: { message: 'Not available in local mode' } };
  }
  const pending = takePending(cookieValue(cookieHeader, PREVIEW_SWITCH_COOKIE), now);
  const previousId = cookieValue(cookieHeader, PREVIEW_COOKIE);
  if (!pending || !previousId || previousId !== pending.stored.fromPreviewId) {
    return expiredPreview();
  }
  previews.delete(pending.id);
  return { status: 200, body: {}, cookies: [clearSwitchCookie(env, secure)] };
}

export function bindPreviewOwner(cookieHeader: string | undefined, ownerId: string): boolean {
  const stored = activeStored(cookieHeader);
  if (!stored || !ownerId.trim()) return false;
  stored.ownerId = ownerId.trim();
  return true;
}

export function dropPreviewSession(cookieHeader: string | undefined): void {
  const id = cookieValue(cookieHeader, PREVIEW_COOKIE);
  if (id) previews.delete(id);
}

export function assertCloudPreview(
  env: NodeJS.ProcessEnv,
  cookieHeader: string | undefined,
  user: PreviewPrincipal,
): { status: 401; message: string } | null {
  let cloud = false;
  try {
    cloud = readDeployMode(env) === 'cloud';
  } catch {
    return { status: 401, message: 'DEPLOY_MODE must be local or cloud' };
  }
  if (!cloud) return null;
  const stored = activeStored(cookieHeader);
  if (!stored) {
    return { status: 401, message: 'This preview has expired. Open it again from Vectoree.' };
  }
  if (!stored.ownerId || user.provider !== 'vectoree' || user.openidId !== stored.ownerId) {
    return { status: 401, message: 'Sign in again for this preview.' };
  }
  return null;
}

/** Cloud returns the visitor key, or '' when there is no preview. Other modes return undefined. */
export function currentVectoreeApiKey(): string | undefined {
  try {
    if (readDeployMode(process.env) !== 'cloud') return undefined;
  } catch {
    return '';
  }
  return currentPreviewCredentials()?.apiKey ?? '';
}

export function installCloudPreviewEnv(): void {
  setRuntimeEnvReader((name) => {
    if (name !== 'VECTOREE_API_KEY') return undefined;
    return currentVectoreeApiKey();
  });
}

function expiredPreview(): PreviewRedeemResult {
  return {
    status: 401,
    body: {
      message: 'This preview has expired. Open it again from Vectoree.',
      code: 'preview_required',
    },
  };
}

function previewCookie(env: NodeJS.ProcessEnv, secure: boolean, id: string): PreviewCookie {
  return {
    name: PREVIEW_COOKIE,
    value: id,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: publicCookiePath(env),
      maxAge: COOKIE_MAX_AGE_MS,
    },
  };
}

function takePending(
  switchCookieValue: string | null,
  now: number,
): { stored: StoredPreview; id: string } | null {
  const id = switchCookieValue ?? '';
  if (!PREVIEW_ID.test(id)) return null;
  const stored = previews.get(id);
  if (!stored?.pending) return null;
  if (now - stored.lastUsed > PENDING_MS) {
    previews.delete(id);
    return null;
  }
  return { stored, id };
}

function activeStored(cookieHeader: string | undefined, now = Date.now()): StoredPreview | null {
  const id = cookieValue(cookieHeader, PREVIEW_COOKIE);
  if (!id || !PREVIEW_ID.test(id)) return null;
  const stored = previews.get(id);
  if (!stored || stored.pending) return null;
  if (now - stored.lastUsed > IDLE_MS) {
    previews.delete(id);
    return null;
  }
  stored.lastUsed = now;
  return stored;
}

function touchPreview(
  cookieHeader: string | undefined,
  now = Date.now(),
): PreviewCredentials | null {
  const stored = activeStored(cookieHeader, now);
  if (!stored) return null;
  return { apiUrl: stored.apiUrl, apiKey: stored.apiKey, projectId: stored.projectId };
}

function switchCookie(env: NodeJS.ProcessEnv, secure: boolean, id: string): PreviewCookie {
  return {
    name: PREVIEW_SWITCH_COOKIE,
    value: id,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: publicCookiePath(env),
      maxAge: PENDING_MS,
    },
  };
}

function clearSwitchCookie(env: NodeJS.ProcessEnv, secure: boolean): PreviewCookie {
  return {
    name: PREVIEW_SWITCH_COOKIE,
    value: '',
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: publicCookiePath(env),
      maxAge: 0,
    },
  };
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
