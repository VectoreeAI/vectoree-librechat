import type { VectoreeAppCredentials } from './appAuth';
import { readErrorMessage } from './text';

const CONVERSATIONS = 'librechat_conversations';
const MESSAGES = 'librechat_messages';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

export type StoredConversation = {
  conversationId: string;
  user: string;
  title: string;
  model?: string;
  endpoint?: string;
  createdAt: string;
  updatedAt: string;
  extra?: JsonValue;
};

export type StoredChatMessage = {
  messageId: string;
  conversationId: string;
  user: string;
  parentMessageId?: string;
  sender?: string;
  text?: string;
  createdAt: string;
  updatedAt: string;
  payload?: JsonValue;
};

export type ConversationWrite = {
  conversationId: string;
  title?: string;
  model?: string | null;
  endpoint?: string | null;
  extra?: JsonValue;
  noUpsert?: boolean;
};

export type MessageWrite = {
  messageId: string;
  conversationId: string;
  parentMessageId?: string | null;
  sender?: string | null;
  text?: string | null;
  payload?: JsonValue;
};

type Column = {
  columnName: string;
  type: 'string' | 'uuid' | 'json';
  isNullable: boolean;
  isUnique: boolean;
};

const ensured = new Map<string, Promise<void>>();

export function createVectoreeChats(options: {
  credentials: () => VectoreeAppCredentials | null;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
    const credentials = options.credentials();
    if (!credentials?.apiKey || !credentials.apiUrl) {
      throw new Error('Vectoree is not connected');
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${credentials.apiKey}`);
    headers.set('Accept', 'application/json');
    if (init?.body != null) headers.set('Content-Type', 'application/json');
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${credentials.apiUrl}${path}`, { ...init, headers });
    } catch {
      throw new Error('Could not reach Vectoree');
    }
    const text = await upstream.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = null;
      }
    }
    return { ok: upstream.ok, status: upstream.status, data };
  }

  async function ensureTables(): Promise<void> {
    const credentials = options.credentials();
    if (!credentials?.apiKey) throw new Error('Vectoree is not connected');
    const key = credentials.apiKey;
    let pending = ensured.get(key);
    if (!pending) {
      pending = createTables().catch((error: unknown) => {
        ensured.delete(key);
        throw error;
      });
      ensured.set(key, pending);
    }
    await pending;
  }

  async function createTables(): Promise<void> {
    const listed = await request('/api/database/tables');
    if (!listed.ok) throw new Error(readErrorMessage(listed.data, 'Could not list tables'));
    const names = tableNames(listed.data);
    if (!names.includes(CONVERSATIONS)) {
      await createTable(CONVERSATIONS, [
        column('user_id', 'string', false),
        column('title', 'string', false),
        column('model', 'string', true),
        column('endpoint', 'string', true),
        column('extra', 'json', true),
      ]);
    }
    if (!names.includes(MESSAGES)) {
      await createTable(MESSAGES, [
        column('conversation_id', 'uuid', false),
        column('user_id', 'string', false),
        column('parent_message_id', 'string', true),
        column('sender', 'string', true),
        column('text', 'string', true),
        column('payload', 'json', true),
      ]);
    }
  }

  async function createTable(tableName: string, columns: Column[]): Promise<void> {
    const created = await request('/api/database/tables', {
      method: 'POST',
      body: JSON.stringify({ tableName, rlsEnabled: false, columns }),
    });
    if (created.ok) return;
    const message = readErrorMessage(created.data, `Could not create ${tableName}`);
    if (created.status === 400 && /already exists/i.test(message)) return;
    throw new Error(message);
  }

  return {
    async listConversations(
      appUserId: string,
      localUserId: string,
      query: { limit?: number; cursor?: string | null; search?: string },
    ): Promise<{ conversations: StoredConversation[]; nextCursor: string | null }> {
      await ensureTables();
      const limit = clampLimit(query.limit);
      const params = new URLSearchParams({
        user_id: `eq.${appUserId}`,
        order: 'updated_at.desc',
        limit: String(limit),
      });
      if (query.cursor) params.set('updated_at', `lt.${query.cursor}`);
      const search = sanitizeSearch(query.search);
      const path = search
        ? `/api/database/records/${CONVERSATIONS}?${params}&title=ilike.*${encodeURIComponent(search)}*`
        : `/api/database/records/${CONVERSATIONS}?${params}`;
      const result = await request(path);
      if (!result.ok) throw new Error(readErrorMessage(result.data, 'Could not list chats'));
      const conversations = rows(result.data).flatMap((row) => conversationFromRow(row, localUserId));
      const nextCursor =
        conversations.length === limit ? conversations[conversations.length - 1]?.updatedAt ?? null : null;
      return { conversations, nextCursor };
    },

    async getConversation(
      appUserId: string,
      localUserId: string,
      conversationId: string,
    ): Promise<StoredConversation | null> {
      if (!UUID.test(conversationId)) return null;
      await ensureTables();
      const params = new URLSearchParams({
        id: `eq.${conversationId}`,
        user_id: `eq.${appUserId}`,
        limit: '1',
      });
      const result = await request(`/api/database/records/${CONVERSATIONS}?${params}`);
      if (!result.ok) throw new Error(readErrorMessage(result.data, 'Could not load the chat'));
      return rows(result.data).flatMap((row) => conversationFromRow(row, localUserId))[0] ?? null;
    },

    async saveConversation(
      appUserId: string,
      localUserId: string,
      input: ConversationWrite,
    ): Promise<StoredConversation | null> {
      if (!UUID.test(input.conversationId)) throw new Error('Invalid conversation id');
      await ensureTables();
      const params = new URLSearchParams({
        id: `eq.${input.conversationId}`,
        user_id: `eq.${appUserId}`,
        limit: '1',
      });
      const existing = await request(`/api/database/records/${CONVERSATIONS}?${params}`);
      if (!existing.ok) throw new Error(readErrorMessage(existing.data, 'Could not save the chat'));
      const current = rows(existing.data)[0];
      if (!current && input.noUpsert) return null;
      const title = clip(input.title, 1024) || readString(current?.title) || 'New Chat';
      const model = input.model === undefined ? readString(current?.model) : input.model || undefined;
      const endpoint =
        input.endpoint === undefined ? readString(current?.endpoint) : input.endpoint || undefined;
      const extra = input.extra === undefined ? jsonValue(current?.extra) : input.extra;
      const fields = {
        title,
        ...(model ? { model } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(extra != null ? { extra } : {}),
      };
      const saved = current
        ? await request(`/api/database/records/${CONVERSATIONS}?${params}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(fields),
          })
        : await request(`/api/database/records/${CONVERSATIONS}`, {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ id: input.conversationId, user_id: appUserId, ...fields }),
          });
      if (!saved.ok) throw new Error(readErrorMessage(saved.data, 'Could not save the chat'));
      const row = rows(saved.data)[0] ?? {
        id: input.conversationId,
        user_id: appUserId,
        ...fields,
        created_at: readString(current?.created_at) ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return conversationFromRow(row, localUserId)[0] ?? null;
    },

    async listMessages(
      appUserId: string,
      localUserId: string,
      conversationId: string,
    ): Promise<StoredChatMessage[]> {
      if (!UUID.test(conversationId)) return [];
      await ensureTables();
      const params = new URLSearchParams({
        conversation_id: `eq.${conversationId}`,
        user_id: `eq.${appUserId}`,
        order: 'created_at.asc',
        limit: '200',
      });
      const result = await request(`/api/database/records/${MESSAGES}?${params}`);
      if (!result.ok) throw new Error(readErrorMessage(result.data, 'Could not load messages'));
      return rows(result.data).flatMap((row) => messageFromRow(row, localUserId));
    },

    async saveMessage(appUserId: string, localUserId: string, input: MessageWrite): Promise<StoredChatMessage | null> {
      if (!UUID.test(input.conversationId) || !UUID.test(input.messageId)) return null;
      await ensureTables();
      const params = new URLSearchParams({
        id: `eq.${input.messageId}`,
        user_id: `eq.${appUserId}`,
        limit: '1',
      });
      const existing = await request(`/api/database/records/${MESSAGES}?${params}`);
      if (!existing.ok) throw new Error(readErrorMessage(existing.data, 'Could not save the message'));
      const fields = {
        conversation_id: input.conversationId,
        parent_message_id: input.parentMessageId || null,
        sender: input.sender || null,
        text: input.text ?? null,
        ...(input.payload != null ? { payload: input.payload } : {}),
      };
      const saved = rows(existing.data)[0]
        ? await request(`/api/database/records/${MESSAGES}?${params}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(fields),
          })
        : await request(`/api/database/records/${MESSAGES}`, {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ id: input.messageId, user_id: appUserId, ...fields }),
          });
      if (!saved.ok) throw new Error(readErrorMessage(saved.data, 'Could not save the message'));
      const row = rows(saved.data)[0] ?? {
        id: input.messageId,
        user_id: appUserId,
        ...fields,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return messageFromRow(row, localUserId)[0] ?? null;
    },

    async deleteConversations(appUserId: string, conversationIds: string[] | null): Promise<string[]> {
      await ensureTables();
      const ids = conversationIds?.filter((id) => UUID.test(id)) ?? null;
      if (ids && ids.length === 0) return [];
      const filter = new URLSearchParams({ user_id: `eq.${appUserId}` });
      if (ids?.length === 1) filter.set('id', `eq.${ids[0]}`);
      if (ids && ids.length > 1) filter.set('id', `in.(${ids.join(',')})`);
      const listed = await request(`/api/database/records/${CONVERSATIONS}?${filter}&select=id&limit=1000`);
      if (!listed.ok) throw new Error(readErrorMessage(listed.data, 'Could not delete chats'));
      const found = rows(listed.data).flatMap((row) => {
        const id = readString(row.id);
        return id ? [id] : [];
      });
      if (found.length === 0) return [];
      const removed = await request(`/api/database/records/${CONVERSATIONS}?${filter}`, { method: 'DELETE' });
      if (!removed.ok) throw new Error(readErrorMessage(removed.data, 'Could not delete chats'));
      const messageParams = new URLSearchParams({ user_id: `eq.${appUserId}` });
      if (found.length === 1) messageParams.set('conversation_id', `eq.${found[0]}`);
      if (found.length > 1) messageParams.set('conversation_id', `in.(${found.join(',')})`);
      const messages = await request(`/api/database/records/${MESSAGES}?${messageParams}`, { method: 'DELETE' });
      if (!messages.ok) throw new Error(readErrorMessage(messages.data, 'Could not delete messages'));
      return found;
    },

    async deleteMessages(appUserId: string, conversationId: string | null): Promise<void> {
      await ensureTables();
      if (conversationId && !UUID.test(conversationId)) return;
      const params = new URLSearchParams({ user_id: `eq.${appUserId}` });
      if (conversationId) params.set('conversation_id', `eq.${conversationId}`);
      const removed = await request(`/api/database/records/${MESSAGES}?${params}`, { method: 'DELETE' });
      if (!removed.ok) throw new Error(readErrorMessage(removed.data, 'Could not delete messages'));
    },
  };
}

function column(columnName: string, type: Column['type'], isNullable: boolean): Column {
  return { columnName, type, isNullable, isUnique: false };
}

function tableNames(data: unknown): string[] {
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === 'string') : [];
}

function rows(data: unknown): Array<{ [key: string]: JsonValue | undefined }> {
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list.filter((item): item is { [key: string]: JsonValue | undefined } => !!item && typeof item === 'object');
}

function conversationFromRow(
  row: { [key: string]: JsonValue | undefined },
  localUserId: string,
): StoredConversation[] {
  const conversationId = readString(row.id);
  const updatedAt = readString(row.updated_at);
  const createdAt = readString(row.created_at) ?? updatedAt;
  if (!conversationId || !createdAt || !updatedAt) return [];
  const model = readString(row.model);
  const endpoint = readString(row.endpoint);
  const extra = jsonValue(row.extra);
  return [
    {
      conversationId,
      user: localUserId,
      title: readString(row.title) || 'New Chat',
      createdAt,
      updatedAt,
      ...(model ? { model } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(extra != null ? { extra } : {}),
    },
  ];
}

function messageFromRow(
  row: { [key: string]: JsonValue | undefined },
  localUserId: string,
): StoredChatMessage[] {
  const messageId = readString(row.id);
  const conversationId = readString(row.conversation_id);
  const createdAt = readString(row.created_at) ?? new Date().toISOString();
  const updatedAt = readString(row.updated_at) ?? createdAt;
  if (!messageId || !conversationId) return [];
  const parentMessageId = readString(row.parent_message_id);
  const sender = readString(row.sender);
  const text = typeof row.text === 'string' ? row.text : undefined;
  const payload = jsonValue(row.payload);
  return [
    {
      messageId,
      conversationId,
      user: localUserId,
      createdAt,
      updatedAt,
      ...(parentMessageId ? { parentMessageId } : {}),
      ...(sender ? { sender } : {}),
      ...(text != null ? { text } : {}),
      ...(payload != null ? { payload } : {}),
    },
  ];
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function jsonValue(value: JsonValue | undefined): JsonValue | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      return value;
    }
  }
  return value;
}

function clip(value: string | undefined, max: number): string {
  return value?.trim().slice(0, max) ?? '';
}

function clampLimit(value: number | undefined): number {
  if (!value || value < 1) return 25;
  return Math.min(value, 100);
}

function sanitizeSearch(value: string | undefined): string {
  return value?.replace(/[*%(),]/g, '').trim().slice(0, 80) ?? '';
}

export function isChatUuid(value: string): boolean {
  return UUID.test(value);
}
