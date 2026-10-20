import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiBaseFromOrigin, normalizeApiUrl } from './url';
import { parseEnvFile, writeEnvFile } from './envfile';
import { VectoreeConfigError } from './errors';
import { nonEmpty } from './text';

export const APP_DATA_DIR = '/app/data';

const CONFIG_KEYS = [
  'apiUrl',
  'accessToken',
  'refreshToken',
  'apiKey',
  'projectId',
  'projectName',
  'keyId',
] as const;

export type StoredLink = {
  apiUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  projectId?: string;
  projectName?: string;
  keyId?: string;
};

export type LinkedCredentials = {
  apiUrl: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey: string;
  projectId: string;
  projectName?: string;
  keyId?: string;
};

export function resolveLinkDataRoot(env: NodeJS.ProcessEnv, projectRoot: string): string {
  const preferred = nonEmpty(env.VECTOREE_LINK_DATA_DIR);
  if (preferred) return preferred;
  if (isDirectory(APP_DATA_DIR)) return APP_DATA_DIR;
  return projectRoot;
}

export function assertLinkRootWritable(root: string): void {
  if (!isWritableDirectory(root)) {
    throw new VectoreeConfigError(
      `Vectoree link data directory is not writable: ${root}. Mount a writable data volume or set VECTOREE_LINK_DATA_DIR.`,
    );
  }
}

export function readStoredLink(root: string): StoredLink {
  const file = configPath(root);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const record = raw as Record<string, unknown>;
    const out: StoredLink = {};
    out.apiUrl = firstString(record, 'apiUrl', 'api_url');
    out.accessToken = firstString(record, 'accessToken', 'access_token');
    out.refreshToken = firstString(record, 'refreshToken', 'refresh_token');
    out.apiKey = firstString(record, 'apiKey', 'api_key');
    out.projectId = firstString(record, 'projectId', 'project_id');
    out.projectName = firstString(record, 'projectName', 'project_name');
    out.keyId = firstString(record, 'keyId', 'key_id');
    return out;
  } catch {
    return {};
  }
}

export type LinkSignal = {
  linked: boolean;
  apiUrl?: string;
  apiBase?: string;
  apiKey?: string;
  projectName?: string;
};

export function readLinkSignal(
  root: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): LinkSignal {
  const stored = readStoredLink(root);
  const volumeEnv = parseEnvFile(path.join(root, '.vectoree', 'env'));
  const dotEnv = parseEnvFile(path.join(projectRoot, '.env'));
  const apiKey =
    nonEmpty(stored.apiKey) ??
    nonEmpty(env.VECTOREE_API_KEY) ??
    nonEmpty(volumeEnv.VECTOREE_API_KEY) ??
    nonEmpty(dotEnv.VECTOREE_API_KEY);
  const apiUrlRaw =
    nonEmpty(stored.apiUrl) ??
    nonEmpty(env.VECTOREE_API_URL) ??
    nonEmpty(volumeEnv.VECTOREE_API_URL) ??
    nonEmpty(dotEnv.VECTOREE_API_URL);
  let apiUrl: string | undefined;
  if (apiUrlRaw) {
    try {
      apiUrl = normalizeApiUrl(apiUrlRaw);
    } catch {
      apiUrl = undefined;
    }
  }
  const apiBase =
    nonEmpty(env.VECTOREE_API_BASE) ??
    nonEmpty(volumeEnv.VECTOREE_API_BASE) ??
    nonEmpty(dotEnv.VECTOREE_API_BASE) ??
    (apiUrl ? apiBaseFromOrigin(apiUrl) : undefined);
  return {
    linked: Boolean(apiKey),
    apiUrl,
    apiBase,
    apiKey,
    projectName: nonEmpty(stored.projectName),
  };
}

const USER_PROVIDED_KEY = 'user_provided';

export function clearUserProvidedOpenAI(projectRoot: string, env: NodeJS.ProcessEnv): void {
  const dotEnv = parseEnvFile(path.join(projectRoot, '.env'));
  const envIsSentinel = env.OPENAI_API_KEY === USER_PROVIDED_KEY;
  const fileIsSentinel = dotEnv.OPENAI_API_KEY === USER_PROVIDED_KEY;
  if (!envIsSentinel && !fileIsSentinel) return;
  if (envIsSentinel) delete env.OPENAI_API_KEY;
  if (!fileIsSentinel) return;
  try {
    writeEnvFile(path.join(projectRoot, '.env'), { OPENAI_API_KEY: '' });
  } catch {
    // process.env is already cleared for this boot when the file cannot be rewritten.
  }
}

export const VECTOREE_IMAGE_MODEL_DEFAULT = 'bytedance-seed/seedream-5-0-pro';
export const VECTOREE_SPEECH_MODEL_DEFAULT = 'sesame/csm-1b';
export const VECTOREE_SPEECH_VOICE_DEFAULT = 'alloy';

export function applyGenerationDefaults(env: NodeJS.ProcessEnv): void {
  if (!nonEmpty(env.VECTOREE_IMAGE_MODEL)) env.VECTOREE_IMAGE_MODEL = VECTOREE_IMAGE_MODEL_DEFAULT;
  if (!nonEmpty(env.VECTOREE_SPEECH_MODEL)) env.VECTOREE_SPEECH_MODEL = VECTOREE_SPEECH_MODEL_DEFAULT;
  if (!nonEmpty(env.VECTOREE_SPEECH_VOICE)) env.VECTOREE_SPEECH_VOICE = VECTOREE_SPEECH_VOICE_DEFAULT;
}

export function prepareVectoreeStartup(options: {
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  linkDataRoot?: string;
}): void {
  applyGenerationDefaults(options.env);
  const root = options.linkDataRoot ?? resolveLinkDataRoot(options.env, options.projectRoot);
  hydrateProcessEnv(root, options.projectRoot, options.env);
}

export function hydrateProcessEnv(root: string, projectRoot: string, env: NodeJS.ProcessEnv): void {
  clearUserProvidedOpenAI(projectRoot, env);
  const signal = readLinkSignal(root, projectRoot, env);
  if (!signal.linked || !signal.apiKey) return;
  if (!nonEmpty(env.VECTOREE_API_KEY)) env.VECTOREE_API_KEY = signal.apiKey;
  if (signal.apiUrl && !nonEmpty(env.VECTOREE_API_URL)) env.VECTOREE_API_URL = signal.apiUrl;
  if (signal.apiBase && !nonEmpty(env.VECTOREE_API_BASE)) env.VECTOREE_API_BASE = signal.apiBase;
}

export function readDeviceId(root: string): string {
  const file = path.join(root, '.vectoree', 'device-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing.slice(0, 128);
  } catch {
    // create one below
  }
  const id = randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod can fail on some filesystems; the file is still written.
  }
  return id;
}

export function persistLinkedCredentials(
  root: string,
  projectRoot: string,
  input: LinkedCredentials,
  env: NodeJS.ProcessEnv,
): void {
  const apiUrl = normalizeApiUrl(input.apiUrl);
  const apiBase = apiBaseFromOrigin(apiUrl);
  const dir = path.join(root, '.vectoree');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readStoredLink(root);
  const ordered: Record<string, string> = {};
  const next: StoredLink = {
    apiUrl,
    accessToken: input.accessToken ?? existing.accessToken,
    refreshToken: input.refreshToken ?? existing.refreshToken,
    apiKey: input.apiKey,
    projectId: input.projectId,
    projectName: input.projectName ?? existing.projectName,
    keyId: input.keyId ?? existing.keyId,
  };
  for (const key of CONFIG_KEYS) {
    const value = next[key];
    if (value) ordered[key] = value;
  }
  const file = configPath(root);
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod can fail on some filesystems; the file is still written.
  }

  const updates = {
    VECTOREE_API_URL: apiUrl,
    VECTOREE_API_KEY: input.apiKey,
    VECTOREE_API_BASE: apiBase,
  };
  writeEnvFile(path.join(dir, 'env'), updates);
  writeProjectEnv(projectRoot, updates);
  env.VECTOREE_API_URL = apiUrl;
  env.VECTOREE_API_KEY = input.apiKey;
  env.VECTOREE_API_BASE = apiBase;
  clearUserProvidedOpenAI(projectRoot, env);
}

function writeProjectEnv(projectRoot: string, updates: Record<string, string>): void {
  const file = path.join(projectRoot, '.env');
  try {
    writeEnvFile(file, updates);
  } catch {
    // The data-volume copy still restores credentials when .env is not writable.
  }
}

function configPath(root: string): string {
  return path.join(root, '.vectoree', 'config.json');
}

function firstString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isWritableDirectory(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, `.vectoree-write-probe-${process.pid}-${randomUUID()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
