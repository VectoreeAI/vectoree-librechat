import { VectoreeConfigError } from './errors';

const PROJECT_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const DEFAULT_API_URL = 'https://vectoree.ai';

export function extractProjectId(text: string): string | null {
  const dashboard = text.match(
    /Dashboard project:[^\n]*\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i,
  );
  if (dashboard?.[1]) return dashboard[1];
  const any = text.match(PROJECT_UUID);
  return any ? any[0] : null;
}

export function normalizeApiUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new VectoreeConfigError('apiUrl is required');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new VectoreeConfigError('apiUrl must be an http(s) origin, for example https://vectoree.ai');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new VectoreeConfigError('apiUrl must use http or https');
  }
  if (url.username || url.password) throw new VectoreeConfigError('apiUrl must not include credentials');
  if (url.search || url.hash) {
    throw new VectoreeConfigError('apiUrl must be an origin, without a query or hash');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new VectoreeConfigError('Use the API origin only, for example https://vectoree.ai');
  }
  return url.origin;
}

export function apiBaseFromOrigin(apiUrl: string): string {
  return `${normalizeApiUrl(apiUrl)}/api/v1`;
}
