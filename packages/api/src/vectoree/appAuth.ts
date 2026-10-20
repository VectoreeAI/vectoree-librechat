import type { VectoreeFetch } from './url';
import { readErrorMessage } from './text';

const PATHS = {
  register: '/api/auth/users',
  login: '/api/auth/sessions',
  'send-verification': '/api/auth/email/send-verification',
  verify: '/api/auth/email/verify',
  'send-reset': '/api/auth/email/send-reset-password',
  'exchange-reset': '/api/auth/email/exchange-reset-password-token',
  'reset-password': '/api/auth/email/reset-password',
} as const;

type AppAuthAction = keyof typeof PATHS;

export type VectoreeAppCredentials = {
  apiUrl: string;
  apiKey: string;
};

export type VectoreeAuthUser = {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
};

export type AppAuthClientBody = {
  message?: string;
  requireEmailVerification?: boolean;
  ok?: boolean;
  resetToken?: string;
};

export type AppAuthOutcome =
  | { kind: 'session'; user: VectoreeAuthUser; issuer: string }
  | { kind: 'response'; status: number; body: AppAuthClientBody };

export type AppAuthSubmitInput = {
  action?: unknown;
  email?: unknown;
  password?: unknown;
  otp?: unknown;
  code?: unknown;
  redirectTo?: unknown;
};

export type VectoreeLinkedUser = {
  id: string;
  email: string;
  name?: string;
  username?: string;
  avatar?: string;
  provider: string;
  role?: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  openidId?: string;
  openidIssuer?: string;
};

export type VectoreeUserCreate = {
  email: string;
  name: string;
  username: string;
  provider: 'vectoree';
  openidId: string;
  openidIssuer: string;
  emailVerified: boolean;
};

export type VectoreeUserPatch = {
  email?: string;
  name?: string;
  emailVerified?: boolean;
  openidId?: string;
  openidIssuer?: string;
};

export type LinkVectoreeUserDeps = {
  findByIdentity: (openidId: string, issuer: string) => Promise<VectoreeLinkedUser | null>;
  findByEmail: (email: string) => Promise<VectoreeLinkedUser | null>;
  allowEmail: (email: string) => Promise<boolean> | boolean;
  createUser: (input: VectoreeUserCreate) => Promise<VectoreeLinkedUser>;
  updateUser: (id: string, patch: VectoreeUserPatch) => Promise<void>;
};

export type LinkVectoreeUserResult =
  | { ok: true; user: VectoreeLinkedUser }
  | { ok: false; status: 403; message: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_PATTERN = /^\d{8}$/;

export function createVectoreeAppAuth(options: {
  credentials: () => VectoreeAppCredentials | null;
  fetchImpl?: VectoreeFetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async submit(input: AppAuthSubmitInput): Promise<AppAuthOutcome> {
      const action = readAction(input.action);
      if (!action) {
        return response(400, { message: 'invalid action' });
      }
      const email = readEmail(input.email);
      if (!email && action !== 'reset-password') {
        return response(400, { message: 'Enter a valid email address' });
      }
      const upstreamBody = actionBody(action, email, input);
      if ('error' in upstreamBody) {
        return response(400, { message: upstreamBody.error });
      }
      const credentials = options.credentials();
      if (!credentials?.apiKey || !credentials.apiUrl) {
        return response(400, { message: 'Vectoree is not connected' });
      }

      let upstream: Response;
      try {
        upstream = await fetchImpl(`${credentials.apiUrl}${PATHS[action]}?client_type=server`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(upstreamBody),
        });
      } catch {
        return response(502, { message: 'Could not reach Vectoree' });
      }

      const payload = await readPayload(upstream);
      const sessionUser = upstream.ok ? readSessionUser(payload) : null;
      if (sessionUser) {
        return { kind: 'session', user: sessionUser, issuer: credentials.apiUrl };
      }
      if (needsVerification(action, upstream.status, payload)) {
        return response(upstream.status === 403 ? 403 : 200, { requireEmailVerification: true });
      }
      if (action === 'send-verification' && upstream.ok) {
        return response(upstream.status, { ok: true });
      }
      if ((action === 'send-reset' || action === 'reset-password') && upstream.ok) {
        return response(upstream.status, { ok: true });
      }
      if (action === 'exchange-reset' && upstream.ok) {
        const resetToken = readResetToken(payload);
        if (!resetToken) {
          return response(502, { message: 'Could not reset password' });
        }
        return response(upstream.status, { resetToken });
      }
      return response(upstream.status || 502, {
        message: readErrorMessage(payload, 'Could not sign in'),
      });
    },
  };
}

export async function linkVectoreeUser(
  identity: VectoreeAuthUser,
  issuer: string,
  deps: LinkVectoreeUserDeps,
): Promise<LinkVectoreeUserResult> {
  const email = identity.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || !identity.id.trim() || !issuer.trim()) {
    return { ok: false, status: 403, message: 'Could not sign in' };
  }
  if (!(await deps.allowEmail(email))) {
    return { ok: false, status: 403, message: 'Email domain is not allowed' };
  }

  const byIdentity = await deps.findByIdentity(identity.id, issuer);
  if (byIdentity) {
    return { ok: true, user: await syncLinkedUser(byIdentity, identity, issuer, email, deps) };
  }

  const byEmail = await deps.findByEmail(email);
  if (byEmail) {
    if (byEmail.provider !== 'vectoree') {
      return {
        ok: false,
        status: 403,
        message: 'An account with this email already uses another sign-in method',
      };
    }
    if (byEmail.openidId && byEmail.openidId !== identity.id) {
      return {
        ok: false,
        status: 403,
        message: 'An account with this email already uses another sign-in method',
      };
    }
    return { ok: true, user: await syncLinkedUser(byEmail, identity, issuer, email, deps) };
  }

  const created = await deps.createUser({
    email,
    name: displayName(identity, email),
    username: usernameFromEmail(email),
    provider: 'vectoree',
    openidId: identity.id,
    openidIssuer: issuer,
    emailVerified: identity.emailVerified,
  });
  return { ok: true, user: created };
}

export function toVectoreeLinkedUser(record: unknown): VectoreeLinkedUser | null {
  if (!record || typeof record !== 'object') return null;
  const user = record as Record<string, unknown>;
  const id = readId(user.id) || readId(user._id);
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!id || !EMAIL_PATTERN.test(email)) return null;
  const name = typeof user.name === 'string' ? user.name : undefined;
  const username = typeof user.username === 'string' ? user.username : undefined;
  const avatar = typeof user.avatar === 'string' ? user.avatar : undefined;
  const role = typeof user.role === 'string' ? user.role : undefined;
  const openidId = typeof user.openidId === 'string' ? user.openidId : undefined;
  const openidIssuer = typeof user.openidIssuer === 'string' ? user.openidIssuer : undefined;
  return {
    id,
    email,
    provider: typeof user.provider === 'string' ? user.provider : '',
    emailVerified: user.emailVerified === true,
    twoFactorEnabled: user.twoFactorEnabled === true,
    ...(name ? { name } : {}),
    ...(username ? { username } : {}),
    ...(avatar ? { avatar } : {}),
    ...(role ? { role } : {}),
    ...(openidId ? { openidId } : {}),
    ...(openidIssuer ? { openidIssuer } : {}),
  };
}

function response(status: number, body: AppAuthClientBody): AppAuthOutcome {
  return { kind: 'response', status, body };
}

function readAction(value: unknown): AppAuthAction | null {
  if (
    value === 'register' ||
    value === 'login' ||
    value === 'verify' ||
    value === 'send-verification' ||
    value === 'send-reset' ||
    value === 'exchange-reset' ||
    value === 'reset-password'
  ) {
    return value;
  }
  return null;
}

function readEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 120 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

const RESET_CODE_PATTERN = /^\d{6}$/;

function actionBody(
  action: AppAuthAction,
  email: string | null,
  input: AppAuthSubmitInput,
):
  | { email?: string; password?: string; otp?: string; code?: string; redirectTo?: string; newPassword?: string }
  | { error: string } {
  if (action === 'verify') {
    const otp = typeof input.otp === 'string' ? input.otp.trim() : '';
    if (!OTP_PATTERN.test(otp) || !email) return { error: 'Enter the 8-digit code' };
    return { email, otp };
  }
  if (action === 'send-verification') return { email: email ?? '' };
  if (action === 'send-reset') {
    if (typeof input.redirectTo === 'string' && input.redirectTo.trim()) {
      const redirectTo = readRedirect(input.redirectTo);
      if (!redirectTo) return { error: 'Reset link must use https' };
      return { email: email ?? '', redirectTo };
    }
    return { email: email ?? '' };
  }
  if (action === 'exchange-reset') {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!RESET_CODE_PATTERN.test(code) || !email) return { error: 'Enter the 6-digit code' };
    return { email, code };
  }
  if (action === 'reset-password') {
    const otp = typeof input.otp === 'string' ? input.otp.trim() : '';
    const newPassword = typeof input.password === 'string' ? input.password : '';
    if (otp.length < 1 || otp.length > 512) return { error: 'Reset link is missing' };
    if (newPassword.length < 6 || newPassword.length > 128) {
      return { error: 'Password must be at least 6 characters' };
    }
    return { newPassword, otp };
  }
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 6 || password.length > 128) {
    return { error: 'Password must be at least 6 characters' };
  }
  return { email: email ?? '', password };
}

function readRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const redirectTo = value.trim();
  if (!redirectTo.startsWith('https://') || redirectTo.length > 300) return null;
  return redirectTo;
}

function readResetToken(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const token = (payload as { token?: unknown }).token;
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 512) return null;
  return trimmed;
}

async function readPayload(upstream: Response): Promise<unknown> {
  const text = await upstream.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readSessionUser(payload: unknown): VectoreeAuthUser | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.accessToken !== 'string' || !record.accessToken.trim()) return null;
  if (!record.user || typeof record.user !== 'object') return null;
  const user = record.user as Record<string, unknown>;
  const id = typeof user.id === 'string' ? user.id.trim() : '';
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!id || id.length > 200 || !EMAIL_PATTERN.test(email)) return null;
  const profile = user.profile;
  const profileRecord =
    profile && typeof profile === 'object' ? (profile as { name?: unknown }) : null;
  const profileName =
    profileRecord && typeof profileRecord.name === 'string' ? profileRecord.name.trim() : '';
  return {
    id,
    email,
    emailVerified: user.emailVerified !== false,
    ...(profileName ? { name: profileName.slice(0, 80) } : {}),
  };
}

function needsVerification(action: AppAuthAction, status: number, payload: unknown): boolean {
  if (action !== 'register' && action !== 'login') return false;
  if (status === 403) return true;
  if (!payload || typeof payload !== 'object') return false;
  return (payload as { requireEmailVerification?: unknown }).requireEmailVerification === true;
}

async function syncLinkedUser(
  existing: VectoreeLinkedUser,
  identity: VectoreeAuthUser,
  issuer: string,
  email: string,
  deps: LinkVectoreeUserDeps,
): Promise<VectoreeLinkedUser> {
  const name = identity.name ?? existing.name;
  const patch: VectoreeUserPatch = {};
  if (existing.email !== email) patch.email = email;
  if (name && existing.name !== name) patch.name = name;
  if (!existing.emailVerified && identity.emailVerified) patch.emailVerified = true;
  if (existing.openidId !== identity.id) patch.openidId = identity.id;
  if (existing.openidIssuer !== issuer) patch.openidIssuer = issuer;
  if (Object.keys(patch).length > 0) {
    await deps.updateUser(existing.id, patch);
  }
  return {
    ...existing,
    email,
    emailVerified: existing.emailVerified || identity.emailVerified,
    openidId: identity.id,
    openidIssuer: issuer,
    ...(name ? { name } : {}),
  };
}

function displayName(identity: VectoreeAuthUser, email: string): string {
  return identity.name?.trim() || usernameFromEmail(email);
}

function usernameFromEmail(email: string): string {
  const local = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, '') ?? '';
  return local.slice(0, 80) || 'user';
}

function readId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (
    value &&
    typeof value === 'object' &&
    'toHexString' in value &&
    typeof (value as { toHexString?: unknown }).toHexString === 'function'
  ) {
    return (value as { toHexString: () => string }).toHexString();
  }
  return '';
}
