import os from 'node:os';
import type { VectoreeFetch } from './url';
import { VectoreeConfigError } from './errors';
import { readErrorMessage } from './text';
import { readDeviceId } from './store';

const KEY_SCOPES = ['gateway:chat', 'gateway:models', 'tools:*', 'database:*', 'storage:*', 'auth:*'];
const FETCH_TIMEOUT_MS = 20_000;

export type MintedSession = {
  accessToken: string;
  refreshToken?: string;
  projectName: string;
  apiKey: string;
  keyId?: string;
};

export async function exchangeAndMint(
  fetchImpl: VectoreeFetch,
  input: {
    apiUrl: string;
    projectId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    root: string;
  },
): Promise<MintedSession> {
  const session = await exchangeCode(fetchImpl, input.apiUrl, {
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
  });
  const projectName = await lookupProjectName(
    fetchImpl,
    input.apiUrl,
    session.accessToken,
    input.projectId,
  );
  const minted = await mintProjectKey(fetchImpl, input.apiUrl, session.accessToken, {
    projectId: input.projectId,
    root: input.root,
  });
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    projectName,
    apiKey: minted.apiKey,
    keyId: minted.keyId,
  };
}

async function exchangeCode(
  fetchImpl: VectoreeFetch,
  apiUrl: string,
  body: { code: string; codeVerifier: string; redirectUri: string },
): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await fetchImpl(`${apiUrl}/api/system/auth/cli/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: body.code,
      code_verifier: body.codeVerifier,
      redirect_uri: body.redirectUri,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readBody(response);
  if (!response.ok) {
    throw new VectoreeConfigError(
      readErrorMessage(data, `Console login failed (${response.status})`),
      502,
    );
  }
  const record = asRecord(data);
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken : '';
  if (!accessToken) throw new VectoreeConfigError('Console login did not return a session', 502);
  return {
    accessToken,
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
  };
}

async function lookupProjectName(
  fetchImpl: VectoreeFetch,
  apiUrl: string,
  accessToken: string,
  projectId: string,
): Promise<string> {
  const response = await fetchImpl(`${apiUrl}/api/projects`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readBody(response);
  if (!response.ok) {
    throw new VectoreeConfigError(
      readErrorMessage(data, `Could not list projects (${response.status})`),
      502,
    );
  }
  const projects = Array.isArray(data) ? data : [];
  const match = projects.find(
    (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === projectId,
  ) as { name?: unknown } | undefined;
  if (!match) throw new VectoreeConfigError('That project was not found on this Vectoree account');
  return typeof match.name === 'string' && match.name.trim() ? match.name.trim() : projectId;
}

async function mintProjectKey(
  fetchImpl: VectoreeFetch,
  apiUrl: string,
  accessToken: string,
  input: { projectId: string; root: string },
): Promise<{ apiKey: string; keyId?: string }> {
  const response = await fetchImpl(`${apiUrl}/api/gateway/keys`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Project-Id': input.projectId,
      'User-Agent': 'VectoreeCLI',
    },
    body: JSON.stringify({
      name: `LibreChat — ${os.hostname()}`.slice(0, 128),
      projectId: input.projectId,
      deviceId: readDeviceId(input.root),
      localFolderPath: input.root,
      scopes: KEY_SCOPES,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readBody(response);
  if (!response.ok) {
    throw new VectoreeConfigError(
      readErrorMessage(data, `Could not create a project key (${response.status})`),
      502,
    );
  }
  const record = asRecord(data);
  if (typeof record.apiKey !== 'string' || !record.apiKey.startsWith('sk-ve-')) {
    throw new VectoreeConfigError('Vectoree did not return a project API key', 502);
  }
  return {
    apiKey: record.apiKey,
    keyId: typeof record.id === 'string' ? record.id : undefined,
  };
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 300) };
  }
}
