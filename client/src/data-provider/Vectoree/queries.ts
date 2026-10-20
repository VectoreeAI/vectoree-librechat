import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryObserverResult } from '@tanstack/react-query';

export const vectoreeLinkStatusKey = ['vectoreeLinkStatus'] as const;
export const vectoreeLinkPollKey = ['vectoreeLinkPoll'] as const;

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

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

export async function fetchVectoreeLinkStatus(): Promise<VectoreeLinkStatus> {
  const response = await fetch('/api/vectoree/link-status', { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error('Could not check Vectoree link status');
  }
  const data = await readJson(response);
  if (!data || typeof data !== 'object' || typeof (data as { linked?: unknown }).linked !== 'boolean') {
    throw new Error('Could not check Vectoree link status');
  }
  const record = data as { linked: boolean; projectName?: unknown; apiUrl?: unknown };
  return {
    linked: record.linked,
    ...(typeof record.projectName === 'string' && record.projectName ? { projectName: record.projectName } : {}),
    ...(typeof record.apiUrl === 'string' && record.apiUrl ? { apiUrl: record.apiUrl } : {}),
  };
}

export async function fetchVectoreeLinkPoll(): Promise<VectoreeConnectSnapshot> {
  const response = await fetch('/api/vectoree/link', { credentials: 'same-origin' });
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
  const response = await fetch('/api/vectoree/link/start', {
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
  const response = await fetch('/api/vectoree/app-auth', {
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
