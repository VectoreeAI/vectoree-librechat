import { apiBaseUrl } from 'librechat-data-provider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryObserverResult } from '@tanstack/react-query';

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

let redeemInflight: { ticket: string; promise: Promise<boolean> } | null = null;

export function redeemPreviewTicketOnce(ticket: string): Promise<boolean> {
  if (redeemInflight?.ticket === ticket) return redeemInflight.promise;
  const promise = redeemPreview(ticket)
    .then(
      () => true,
      () => false,
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

export async function redeemPreview(ticket: string): Promise<{ projectId?: string }> {
  const response = await fetch(vectoreeUrl('/api/vectoree/preview/redeem'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const record = data && typeof data === 'object' ? (data as { message?: unknown }) : {};
    const message = typeof record.message === 'string' ? record.message : 'This preview has expired. Open it again from Vectoree.';
    throw new Error(message);
  }
  const record = data && typeof data === 'object' ? (data as { projectId?: unknown }) : {};
  return typeof record.projectId === 'string' ? { projectId: record.projectId } : {};
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
  const response = await fetch(vectoreeUrl('/api/vectoree/link-status'), { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error('Could not check Vectoree link status');
  }
  const data = await readJson(response);
  if (!data || typeof data !== 'object' || typeof (data as { linked?: unknown }).linked !== 'boolean') {
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
    ...(typeof record.projectName === 'string' && record.projectName ? { projectName: record.projectName } : {}),
    ...(typeof record.apiUrl === 'string' && record.apiUrl ? { apiUrl: record.apiUrl } : {}),
    ...(record.deployMode === 'local' || record.deployMode === 'cloud' ? { deployMode: record.deployMode } : {}),
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
    const message = typeof record.message === 'string' ? record.message : 'Could not start Vectoree login';
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

export function useVectoreeLinkPoll(enabled: boolean): QueryObserverResult<VectoreeConnectSnapshot> {
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
  token?: string;
  resetToken?: string;
  twoFAPending?: boolean;
  tempToken?: string;
  message?: string;
};

export async function submitVectoreeAppAuth(input: {
  action: 'register' | 'login' | 'verify' | 'send-verification' | 'send-reset' | 'exchange-reset' | 'reset-password';
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
  return {
    ok: response.ok,
    status: response.status,
    requireEmailVerification: record.requireEmailVerification === true,
    ...(typeof record.token === 'string' ? { token: record.token } : {}),
    ...(typeof record.resetToken === 'string' ? { resetToken: record.resetToken } : {}),
    ...(record.twoFAPending === true ? { twoFAPending: true } : {}),
    ...(typeof record.tempToken === 'string' ? { tempToken: record.tempToken } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
  };
}

export function useMarkVectoreeLinked() {
  const queryClient = useQueryClient();
  return (status: VectoreeLinkStatus) => {
    queryClient.setQueryData(vectoreeLinkStatusKey, status);
  };
}
