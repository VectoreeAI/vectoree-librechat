import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { VectoreeFetch } from './url';
import {
  assertLinkRootWritable,
  hydrateProcessEnv,
  persistLinkedCredentials,
  readLinkSignal,
  resolveLinkDataRoot,
} from './store';
import { DEFAULT_API_URL, configuredPublicOrigin, extractProjectId, normalizeApiUrl } from './url';
import { VectoreeConfigError } from './errors';
import { exchangeAndMint } from './oauth';
import { redactSecrets } from './text';

const LINK_TIMEOUT_MS = 180_000;

export function readVectoreeAppCredentials(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): { apiUrl: string; apiKey: string } | null {
  const root = resolveLinkDataRoot(env, projectRoot);
  const signal = readLinkSignal(root, projectRoot, env);
  if (!signal.apiKey) return null;
  return { apiUrl: signal.apiUrl ?? DEFAULT_API_URL, apiKey: signal.apiKey };
}

export type VectoreeLinkStatus = {
  linked: boolean;
  projectName?: string;
  apiUrl?: string;
};

export type VectoreeConnectSnapshot = {
  status: 'idle' | 'pending' | 'linked' | 'error';
  authorizeUrl?: string;
  message?: string;
  apiUrl?: string;
  projectName?: string;
};

export type VectoreeLinkOptions = {
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  linkDataRoot?: string;
  fetchImpl?: VectoreeFetch;
  now?: () => number;
  timeoutMs?: number;
  onLinked?: () => Promise<void> | void;
  logger?: { error: (message: string) => void };
};

type PendingLink = {
  apiUrl: string;
  projectId: string;
  verifier: string;
  state: string;
  redirectUri: string;
  authorizeUrl: string;
  expiresAt: number;
  consumed: boolean;
};

type SessionState = {
  status: 'idle' | 'pending' | 'linked' | 'error';
  authorizeUrl?: string;
  message?: string;
  apiUrl?: string;
  projectName?: string;
};

export function createVectoreeLink(options: VectoreeLinkOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? LINK_TIMEOUT_MS;
  const root = options.linkDataRoot ?? resolveLinkDataRoot(options.env, options.projectRoot);
  hydrateProcessEnv(root, options.projectRoot, options.env);

  let pending: PendingLink | null = null;
  let session: SessionState = { status: 'idle' };

  return {
    linkStatus(): VectoreeLinkStatus {
      return publicStatus(readLinkSignal(root, options.projectRoot, options.env));
    },
    appCredentials(): { apiUrl: string; apiKey: string } | null {
      const signal = readLinkSignal(root, options.projectRoot, options.env);
      if (!signal.apiKey) return null;
      return { apiUrl: signal.apiUrl ?? DEFAULT_API_URL, apiKey: signal.apiKey };
    },
    poll(): VectoreeConnectSnapshot {
      expirePending();
      if (session.status === 'idle' || session.status === 'error') {
        const signal = readLinkSignal(root, options.projectRoot, options.env);
        if (signal.linked) {
          return publicSnapshot({
            status: 'linked',
            apiUrl: signal.apiUrl,
            projectName: signal.projectName,
          });
        }
      }
      return publicSnapshot(session);
    },
    start(input: { apiUrl?: string; projectId?: string; publicOrigin: string }): VectoreeConnectSnapshot {
      assertLinkRootWritable(root);
      const apiUrl = normalizeApiUrl(input.apiUrl?.trim() || DEFAULT_API_URL);
      const projectId = extractProjectId(input.projectId?.trim() ?? '');
      if (!projectId) {
        throw new VectoreeConfigError('projectId must be a UUID from the Vectoree console');
      }
      const publicOrigin = normalizeApiUrl(input.publicOrigin);
      const redirectUri = `${publicOrigin}/api/vectoree/link/callback`;
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(16).toString('hex');
      const authorize = new URL(`${apiUrl}/api/system/auth/cli/authorize`);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('state', state);
      const authorizeUrl = authorize.toString();
      pending = {
        apiUrl,
        projectId,
        verifier,
        state,
        redirectUri,
        authorizeUrl,
        expiresAt: now() + timeoutMs,
        consumed: false,
      };
      session = { status: 'pending', authorizeUrl, apiUrl };
      return publicSnapshot(session);
    },
    async callback(input: { code?: string; state?: string }): Promise<string> {
      const code = input.code?.trim() ?? '';
      const state = input.state?.trim() ?? '';
      const current = pending;
      if (current && !current.consumed && now() > current.expiresAt) {
        const message = 'Console login timed out. Try connecting again.';
        session = { status: 'error', apiUrl: current.apiUrl, message };
        pending = null;
        return callbackHtml(message, false);
      }
      if (!current || current.consumed || !code || !safeEqual(state, current.state)) {
        return callbackHtml('Invalid Vectoree login callback.', false);
      }
      current.consumed = true;
      try {
        const minted = await exchangeAndMint(fetchImpl, {
          apiUrl: current.apiUrl,
          projectId: current.projectId,
          code,
          codeVerifier: current.verifier,
          redirectUri: current.redirectUri,
          root,
        });
        persistLinkedCredentials(
          root,
          options.projectRoot,
          {
            apiUrl: current.apiUrl,
            accessToken: minted.accessToken,
            refreshToken: minted.refreshToken,
            apiKey: minted.apiKey,
            projectId: current.projectId,
            projectName: minted.projectName,
            keyId: minted.keyId,
          },
          options.env,
        );
        await rememberResetOrigin(fetchImpl, options.env, current.apiUrl, minted.apiKey, options.logger);
        await notifyLinked(options);
        session = {
          status: 'linked',
          apiUrl: current.apiUrl,
          projectName: minted.projectName,
        };
        pending = null;
        return callbackHtml('Vectoree connected. You can close this window and return to LibreChat.', true);
      } catch (error) {
        const message = redactSecrets(
          error instanceof Error ? error.message : 'Could not connect Vectoree',
        );
        session = { status: 'error', apiUrl: current.apiUrl, message };
        pending = null;
        options.logger?.error(`[vectoree-link] ${message}`);
        return callbackHtml(message, false);
      }
    },
  };

  function expirePending(): void {
    if (!pending || pending.consumed) return;
    if (now() <= pending.expiresAt) return;
    session = {
      status: 'error',
      apiUrl: pending.apiUrl,
      message: 'Console login timed out. Try connecting again.',
    };
    pending = null;
  }
}

function publicStatus(signal: { linked: boolean; apiUrl?: string; projectName?: string }): VectoreeLinkStatus {
  if (!signal.linked) return { linked: false };
  return {
    linked: true,
    ...(signal.projectName ? { projectName: signal.projectName } : {}),
    ...(signal.apiUrl ? { apiUrl: signal.apiUrl } : {}),
  };
}

function publicSnapshot(state: SessionState): VectoreeConnectSnapshot {
  return {
    status: state.status,
    ...(state.authorizeUrl ? { authorizeUrl: state.authorizeUrl } : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.apiUrl ? { apiUrl: state.apiUrl } : {}),
    ...(state.projectName ? { projectName: state.projectName } : {}),
  };
}

async function rememberResetOrigin(
  fetchImpl: VectoreeFetch,
  env: NodeJS.ProcessEnv,
  apiUrl: string,
  apiKey: string,
  logger: VectoreeLinkOptions['logger'],
): Promise<void> {
  const origin = configuredPublicOrigin(env);
  if (!origin) return;
  const pattern = `${origin}/reset-password**`;
  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const listed = await fetchImpl(`${apiUrl}/api/auth/config`, { headers });
    if (!listed.ok) {
      logger?.error('[vectoree-link] could not read the reset-link allowlist');
      return;
    }
    const current = await readAllowlist(listed);
    if (!current) {
      logger?.error('[vectoree-link] could not read the reset-link allowlist');
      return;
    }
    if (current.includes(pattern)) return;
    const saved = await fetchImpl(`${apiUrl}/api/auth/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ allowedRedirectUrls: [...current, pattern] }),
    });
    if (!saved.ok) {
      logger?.error('[vectoree-link] could not store the reset-link allowlist');
    }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : 'allowlist failed');
    logger?.error(`[vectoree-link] could not store the reset-link allowlist: ${message}`);
  }
}

async function readAllowlist(response: Response): Promise<string[] | null> {
  const text = await response.text();
  if (!text) return [];
  try {
    const data = JSON.parse(text) as { allowedRedirectUrls?: unknown };
    if (data.allowedRedirectUrls == null) return [];
    if (!Array.isArray(data.allowedRedirectUrls)) return null;
    return data.allowedRedirectUrls.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

async function notifyLinked(options: VectoreeLinkOptions): Promise<void> {
  try {
    await options.onLinked?.();
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : 'config reload failed');
    options.logger?.error(`[vectoree-link] config reload failed: ${message}`);
  }
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function callbackHtml(message: string, ok: boolean): string {
  const title = ok ? 'Vectoree connected' : 'Vectoree login failed';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title></head><body>`,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    '<p><a href="/link">Return to LibreChat</a></p></body></html>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
