export function redactSecrets(message: string): string {
  return message
    .replace(/sk-ve-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 300);
}

export function readErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const record = data as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  const text = message || error;
  return text ? redactSecrets(text) : fallback;
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
