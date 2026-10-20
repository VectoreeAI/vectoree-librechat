import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { VectoreeFetch } from './url';
import { DEFAULT_API_URL, normalizeApiUrl } from './url';
import { nonEmpty, readErrorMessage } from './text';
import { readDeployMode } from './mode';

export const PREVIEW_COOKIE = 've_preview';

const IDLE_MS = 12 * 60 * 60 * 1000;
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REDEEM_PATH = '/api/system/starter/preview/redeem';
const TICKET = /^\S{16,512}$/;
const PREVIEW_ID = /^[a-f0-9]{64}$/;

export type PreviewCredentials = {
  apiUrl: string;
  apiKey: string;
  projectId: string;
};

type StoredPreview = PreviewCredentials & { lastUsed: number };

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
  body: { projectId?: string; message?: string; code?: 'preview_required' };
  cookie?: PreviewCookie;
};

export function clearPreviews(): void {
  previews.clear();
}

export function dropIdlePreviews(now: number): void {
  for (const [id, stored] of previews) {
    if (now - stored.lastUsed > IDLE_MS) previews.delete(id);
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
      body: { message: readErrorMessage(data, `Vectoree could not open the preview (${upstream.status})`) },
    };
  }

  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : '';
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
  if (!apiKey.startsWith('sk-ve-') || !projectId) {
    return { status: 502, body: { message: 'Vectoree returned an unexpected preview' } };
  }

  const previous = cookieValue(input.cookieHeader, PREVIEW_COOKIE);
  if (previous && PREVIEW_ID.test(previous)) previews.delete(previous);
  const id = randomBytes(32).toString('hex');
  previews.set(id, { apiUrl, apiKey, projectId, lastUsed: input.now?.() ?? Date.now() });
  return {
    status: 200,
    body: { projectId },
    cookie: {
      name: PREVIEW_COOKIE,
      value: id,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: input.secure,
        path: publicCookiePath(input.env),
        maxAge: COOKIE_MAX_AGE_MS,
      },
    },
  };
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

function touchPreview(cookieHeader: string | undefined, now = Date.now()): PreviewCredentials | null {
  const id = cookieValue(cookieHeader, PREVIEW_COOKIE);
  if (!id || !PREVIEW_ID.test(id)) return null;
  const stored = previews.get(id);
  if (!stored) return null;
  if (now - stored.lastUsed > IDLE_MS) {
    previews.delete(id);
    return null;
  }
  stored.lastUsed = now;
  return { apiUrl: stored.apiUrl, apiKey: stored.apiKey, projectId: stored.projectId };
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
