import fs from 'node:fs';
import path from 'node:path';

const ENV_LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/;

export function parseEnvFile(file: string): Record<string, string> {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    throw error;
  }
}

export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (rawKey) out[rawKey] = value;
  }
  return out;
}

export function upsertEnv(content: string, updates: Record<string, string>): string {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = ENV_LINE.exec(line);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  return `${next.join('\n')}\n`;
}

export function writeEnvFile(file: string, updates: Record<string, string>): void {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, upsertEnv(current, updates), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod can fail on some filesystems; the file is still written.
  }
}
