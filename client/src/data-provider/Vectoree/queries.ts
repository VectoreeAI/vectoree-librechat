import { apiBaseUrl, request } from 'librechat-data-provider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryObserverResult } from '@tanstack/react-query';
import type { TUser } from 'librechat-data-provider';

export const vectoreeLinkStatusKey = ['vectoreeLinkStatus'] as const;
export const vectoreeLinkPollKey = ['vectoreeLinkPoll'] as const;

export type VectoreeLinkStatus = {
  linked: boolean;
  projectName?: string;
  apiUrl?: string;
  deployMode?: 'local' | 'cloud';
  previewed?: boolean;
};

export type VectoreeGate = 'loading' | 'app' | 'link' | 'expired';

function vectoreeUrl(path: string): string {
  return `${apiBaseUrl()}${path}`;
}

export function isVectoreeDeploymentQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === vectoreeLinkStatusKey[0] || queryKey[0] === vectoreeLinkPollKey[0];
}

export function nextVectoreeGate(
  status: VectoreeLinkStatus | undefined,
  pendingTicket: boolean,
  failed: boolean,
): VectoreeGate {
  if (pendingTicket) return 'loading';
  if (!status) return failed ? 'link' : 'loading';
  if (status.deployMode === 'cloud') return status.previewed === true ? 'app' : 'expired';
  if (failed || !status.linked) return 'link';
  return 'app';
}

export type PreviewRedeemBody = {
  projectId?: string;
  projectName?: string;
  confirm?: boolean;
};

let redeemInflight: { ticket: string; promise: Promise<PreviewRedeemBody | null> } | null = null;

export function redeemPreviewTicketOnce(ticket: string): Promise<PreviewRedeemBody | null> {
  if (redeemInflight?.ticket === ticket) return redeemInflight.promise;
  const promise = redeemPreview(ticket)
    .then(
      (body) => body,
      () => null,
    )
    .finally(() => {
      if (redeemInflight?.ticket === ticket) redeemInflight = null;
    });
  redeemInflight = { ticket, promise };
  return promise;
}

export function forgetPreviewTicket(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('ticket')) return;
  url.searchParams.delete('ticket');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Read ?ticket= and strip it from the address bar immediately to shrink Referer/history leakage. */
export function takePreviewTicketFromLocation(): string | null {
  const url = new URL(window.location.href);
  const ticket = url.searchParams.get('ticket');
  if (ticket === null) return null;
  url.searchParams.delete('ticket');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const trimmed = ticket.trim();
  return trimmed ? trimmed : null;
}

function readPreviewBody(data: unknown): PreviewRedeemBody {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    ...(typeof record.projectId === 'string' ? { projectId: record.projectId } : {}),
    ...(typeof record.projectName === 'string' ? { projectName: record.projectName } : {}),
    ...(record.confirm === true ? { confirm: true } : {}),
  };
}

async function postPreview(path: string, body: Record<string, string>): Promise<PreviewRedeemBody> {
  const response = await fetch(vectoreeUrl(path), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const record = data && typeof data === 'object' ? (data as { message?: unknown }) : {};
    const message =
      typeof record.message === 'string'
        ? record.message
        : 'This preview has expired. Open it again from Vectoree.';
    throw new Error(message);
  }
  return readPreviewBody(data);
}

export async function redeemPreview(ticket: string): Promise<PreviewRedeemBody> {
  return postPreview('/api/vectoree/preview/redeem', { ticket });
}

export async function confirmPreviewSwitch(): Promise<PreviewRedeemBody> {
  // switch token is bound to HttpOnly ve_preview_switch; body token is unused.
  return postPreview('/api/vectoree/preview/confirm', {});
}

export async function declinePreviewSwitch(): Promise<void> {
  await postPreview('/api/vectoree/preview/decline', {});
}

export type VectoreeConnectSnapshot = {
  status: 'idle' | 'pending' | 'linked' | 'error';
  authorizeUrl?: string;
  message?: string;
  apiUrl?: string;
  projectName?: string;
};

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

export async function fetchVectoreeLinkStatus(): Promise<VectoreeLinkStatus> {
  const response = await fetch(vectoreeUrl('/api/vectoree/link-status'), {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error('Could not check Vectoree link status');
  }
  const data = await readJson(response);
  if (
    !data ||
    typeof data !== 'object' ||
    typeof (data as { linked?: unknown }).linked !== 'boolean'
  ) {
    throw new Error('Could not check Vectoree link status');
  }
  const record = data as {
    linked: boolean;
    projectName?: unknown;
    apiUrl?: unknown;
    deployMode?: unknown;
    previewed?: unknown;
  };
  return {
    linked: record.linked,
    ...(typeof record.projectName === 'string' && record.projectName
      ? { projectName: record.projectName }
      : {}),
    ...(typeof record.apiUrl === 'string' && record.apiUrl ? { apiUrl: record.apiUrl } : {}),
    ...(record.deployMode === 'local' || record.deployMode === 'cloud'
      ? { deployMode: record.deployMode }
      : {}),
    ...(record.previewed === true ? { previewed: true } : { previewed: false }),
  };
}

export async function fetchVectoreeLinkPoll(): Promise<VectoreeConnectSnapshot> {
  const response = await fetch(vectoreeUrl('/api/vectoree/link'), { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error('Could not check Vectoree link progress');
  }
  const data = await readJson(response);
  if (!data || typeof data !== 'object') {
    throw new Error('Could not check Vectoree link progress');
  }
  return parseSnapshot(data as Record<string, unknown>);
}

function parseSnapshot(record: Record<string, unknown>): VectoreeConnectSnapshot {
  const status = record.status;
  if (status !== 'idle' && status !== 'pending' && status !== 'linked' && status !== 'error') {
    throw new Error('Could not read Vectoree link progress');
  }
  return {
    status,
    ...(typeof record.authorizeUrl === 'string' ? { authorizeUrl: record.authorizeUrl } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.apiUrl === 'string' ? { apiUrl: record.apiUrl } : {}),
    ...(typeof record.projectName === 'string' ? { projectName: record.projectName } : {}),
  };
}

export async function startVectoreeLink(input: {
  apiUrl: string;
  projectId: string;
}): Promise<VectoreeConnectSnapshot> {
  const response = await fetch(vectoreeUrl('/api/vectoree/link/start'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await readJson(response);
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      typeof record.message === 'string' ? record.message : 'Could not start Vectoree login';
    throw new Error(message);
  }
  return parseSnapshot(record);
}

export function useVectoreeLinkStatus(): QueryObserverResult<VectoreeLinkStatus> {
  return useQuery(vectoreeLinkStatusKey, fetchVectoreeLinkStatus, {
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
}

export function useVectoreeLinkPoll(
  enabled: boolean,
): QueryObserverResult<VectoreeConnectSnapshot> {
  return useQuery(vectoreeLinkPollKey, fetchVectoreeLinkPoll, {
    enabled,
    retry: false,
    refetchInterval: enabled ? 2000 : false,
    refetchOnWindowFocus: false,
  });
}

export type VectoreeAppAuthResult = {
  ok: boolean;
  status: number;
  requireEmailVerification: boolean;
  requirePassword: boolean;
  usePassword: boolean;
  token?: string;
  user?: TUser;
  resetToken?: string;
  twoFAPending?: boolean;
  tempToken?: string;
  message?: string;
  code?: string;
  billingUrl?: string;
};

function readSessionUser(value: unknown): TUser | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string' || typeof user.email !== 'string') return undefined;
  return {
    id: user.id,
    email: user.email,
    username: typeof user.username === 'string' ? user.username : user.email,
    name: typeof user.name === 'string' ? user.name : '',
    avatar: typeof user.avatar === 'string' ? user.avatar : '',
    role: typeof user.role === 'string' ? user.role : 'USER',
    provider: typeof user.provider === 'string' ? user.provider : 'vectoree',
    createdAt: typeof user.createdAt === 'string' ? user.createdAt : '',
    updatedAt: typeof user.updatedAt === 'string' ? user.updatedAt : '',
  };
}

export async function submitVectoreeAppAuth(input: {
  action:
    | 'start'
    | 'register'
    | 'login'
    | 'verify'
    | 'send-verification'
    | 'send-reset'
    | 'exchange-reset'
    | 'reset-password';
  email?: string;
  password?: string;
  otp?: string;
  code?: string;
}): Promise<VectoreeAppAuthResult> {
  const response = await fetch(vectoreeUrl('/api/vectoree/app-auth'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await readJson(response);
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const user = readSessionUser(record.user);
  return {
    ok: response.ok,
    status: response.status,
    requireEmailVerification: record.requireEmailVerification === true,
    requirePassword: record.requirePassword === true,
    usePassword: record.usePassword === true,
    ...(typeof record.token === 'string' ? { token: record.token } : {}),
    ...(user ? { user } : {}),
    ...(typeof record.resetToken === 'string' ? { resetToken: record.resetToken } : {}),
    ...(record.twoFAPending === true ? { twoFAPending: true } : {}),
    ...(typeof record.tempToken === 'string' ? { tempToken: record.tempToken } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...readWalletBilling(record),
  };
}

function readWalletBilling(
  record: Record<string, unknown>,
): { code: string; billingUrl: string } | undefined {
  if (record.code !== 'BILLING_WALLET_NOT_ACTIVATED' || typeof record.billingUrl !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(record.billingUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return { code: 'BILLING_WALLET_NOT_ACTIVATED', billingUrl: record.billingUrl };
  } catch {
    return undefined;
  }
}

export async function submitVectoreePassword(input: {
  password: string;
  confirmPassword: string;
  code?: string;
}): Promise<{ ok: boolean; codeSent: boolean; message?: string }> {
  try {
    const data: unknown = await request.post(vectoreeUrl('/api/vectoree/account/password'), input);
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    return {
      ok: true,
      codeSent: record.codeSent === true,
      ...(typeof record.message === 'string' ? { message: record.message } : {}),
    };
  } catch (error) {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    const message = response?.data?.message;
    return {
      ok: false,
      codeSent: false,
      ...(typeof message === 'string' ? { message } : {}),
    };
  }
}

export function useMarkVectoreeLinked() {
  const queryClient = useQueryClient();
  return (status: VectoreeLinkStatus) => {
    queryClient.setQueryData(vectoreeLinkStatusKey, status);
  };
}
