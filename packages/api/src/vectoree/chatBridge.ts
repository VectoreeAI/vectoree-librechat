import type { JsonValue, StoredChatMessage, StoredConversation } from './chats';
import type { VectoreeAppCredentials } from './appAuth';
import type { VectoreeFetch } from './url';
import { createVectoreeChats, isChatUuid, sanitizeConversationCursor } from './chats';

const OWNER_CACHE_TTL_MS = 60_000;
const OWNER_CACHE_LIMIT = 200;

type MongoConversation = {
  subagentThread?: unknown;
  conversationId?: string;
};

type CursorOptions = {
  cursor?: string | null;
  limit?: number;
  isArchived?: boolean;
  pinned?: boolean;
  tags?: string[];
  search?: string;
  projectId?: string;
};

type SaveContext = {
  userId?: string;
  isTemporary?: boolean;
};

type ConvoData = {
  conversationId?: string;
  newConversationId?: string;
  subagentThread?: unknown;
  title?: string;
  model?: string | null;
  endpoint?: string | null;
};

type MessageData = {
  conversationId?: string;
  messageId?: string;
  newMessageId?: string;
  parentMessageId?: string | null;
  sender?: string | null;
  text?: string | null;
  isCreatedByUser?: boolean;
};

type MessageFilter = {
  user?: unknown;
  conversationId?: unknown;
  messageId?: unknown;
};

type DeleteFilter = {
  conversationId?: unknown;
};

export type VectoreeChatMongo = {
  getConvosByCursor: (
    user: string,
    options?: CursorOptions,
  ) => Promise<{ conversations: unknown[]; nextCursor: string | null }>;
  getConvo: (user: string, conversationId: string) => Promise<MongoConversation | null>;
  getConvoTitle: (user: string, conversationId: string) => Promise<string | null>;
  saveConvo: (ctx: SaveContext, data: ConvoData, metadata?: { noUpsert?: boolean }) => Promise<unknown>;
  deleteConvos: (
    user: string,
    filter: DeleteFilter,
    options?: unknown,
  ) => Promise<{ deletedCount?: number; conversationIds?: string[]; messages?: { deletedCount?: number } }>;
  getMessages: (filter: MessageFilter, select?: string) => Promise<unknown[]>;
  saveMessage: (ctx: SaveContext, params: MessageData, metadata?: unknown) => Promise<unknown>;
  deleteMessages: (filter: MessageFilter) => Promise<unknown>;
};

const SKIPPED_CONVO_KEYS = new Set([
  'conversationId',
  'newConversationId',
  'user',
  'title',
  'model',
  'endpoint',
  'messages',
  'createdAt',
  'updatedAt',
  '_id',
  '__v',
  'subagentThread',
]);

const SKIPPED_MESSAGE_KEYS = new Set([
  'conversationId',
  'messageId',
  'newMessageId',
  'user',
  'sender',
  'text',
  'parentMessageId',
  'createdAt',
  'updatedAt',
  '_id',
  '__v',
]);

export type VectoreeChatBridge = {
  getConvosByCursor: VectoreeChatMongo['getConvosByCursor'];
  getConvo: (user: string, conversationId: string) => Promise<unknown>;
  getConvoTitle: VectoreeChatMongo['getConvoTitle'];
  saveConvo: VectoreeChatMongo['saveConvo'];
  deleteConvos: VectoreeChatMongo['deleteConvos'];
  getMessages: VectoreeChatMongo['getMessages'];
  saveMessage: VectoreeChatMongo['saveMessage'];
  deleteMessages: VectoreeChatMongo['deleteMessages'];
};

export function createVectoreeChatBridge(options: {
  methods: VectoreeChatMongo;
  credentials: () => VectoreeAppCredentials | null;
  findOwner: (userId: string) => Promise<string | null>;
  fetchImpl?: VectoreeFetch;
}): VectoreeChatBridge {
  const store = createVectoreeChats({
    credentials: options.credentials,
    fetchImpl: options.fetchImpl,
  });
  const owners = new Map<string, { id: string | null; expires: number }>();

  async function ownerId(userId: string): Promise<string | null> {
    const apiKey = options.credentials()?.apiKey ?? '';
    if (!apiKey) return null;
    const cacheKey = `${apiKey}:${userId}`;
    const cached = owners.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expires > now) return cached.id;
    const appUserId = await options.findOwner(userId);
    owners.delete(cacheKey);
    if (owners.size >= OWNER_CACHE_LIMIT) {
      const oldest = owners.keys().next().value;
      if (oldest) owners.delete(oldest);
    }
    owners.set(cacheKey, { id: appUserId, expires: now + OWNER_CACHE_TTL_MS });
    return appUserId;
  }

  async function isSubagent(userId: string, conversationId: string): Promise<boolean> {
    const existing = await options.methods.getConvo(userId, conversationId);
    return existing?.subagentThread != null;
  }

  return {
    async getConvosByCursor(
      user: string,
      query?: CursorOptions,
    ): Promise<{ conversations: unknown[]; nextCursor: string | null }> {
      const appUserId = await ownerId(user);
      if (!appUserId || query?.isArchived || query?.pinned || query?.tags?.length || query?.projectId) {
        return options.methods.getConvosByCursor(user, query);
      }
      const decoded = decodeListCursor(query?.cursor);
      const limit = query?.limit;
      let vectoreeFailed = false;
      let vectoreePage: { conversations: StoredConversation[]; nextCursor: string | null } = {
        conversations: [],
        nextCursor: null,
      };
      try {
        vectoreePage = await store.listConversations(appUserId, user, {
          limit,
          cursor: decoded.v,
          search: query?.search,
        });
      } catch {
        vectoreeFailed = true;
      }
      const mongoPage = await options.methods.getConvosByCursor(user, { ...query, cursor: decoded.m });
      if (vectoreeFailed) {
        if (mongoPage.conversations.length === 0 && !mongoPage.nextCursor) {
          throw new Error('Could not load chats from Vectoree. Try again.');
        }
        return {
          conversations: mongoPage.conversations,
          nextCursor: encodeListCursor({
            v: decoded.v,
            m: mongoPage.nextCursor,
          }),
        };
      }
      return mergeConversationPages(vectoreePage, mongoPage, decoded, clampPage(limit));
    },

    async getConvo(user: string, conversationId: string): Promise<unknown> {
      const appUserId = await ownerId(user);
      if (!appUserId || !isChatUuid(conversationId)) {
        return options.methods.getConvo(user, conversationId);
      }
      try {
        const stored = await store.getConversation(appUserId, user, conversationId);
        if (stored) return presentConversation(stored);
      } catch (error) {
        const legacy = await options.methods.getConvo(user, conversationId);
        if (legacy) return legacy;
        throw error;
      }
      return options.methods.getConvo(user, conversationId);
    },

    async getConvoTitle(user: string, conversationId: string): Promise<string | null> {
      const appUserId = await ownerId(user);
      if (!appUserId || !isChatUuid(conversationId)) {
        return options.methods.getConvoTitle(user, conversationId);
      }
      try {
        const stored = await store.getConversation(appUserId, user, conversationId);
        if (stored) return stored.title;
      } catch (error) {
        const legacy = await options.methods.getConvoTitle(user, conversationId);
        if (legacy) return legacy;
        throw error;
      }
      return options.methods.getConvoTitle(user, conversationId);
    },

    async saveConvo(
      ctx: SaveContext,
      data: ConvoData,
      metadata?: { noUpsert?: boolean },
    ): Promise<unknown> {
      const userId = ctx.userId ?? '';
      const conversationId = data.conversationId ?? '';
      const moved = data.newConversationId && data.newConversationId !== conversationId;
      if (!userId || ctx.isTemporary || data.subagentThread != null || moved || !isChatUuid(conversationId)) {
        return options.methods.saveConvo(ctx, data, metadata);
      }
      const appUserId = await ownerId(userId);
      if (!appUserId || (await isSubagent(userId, conversationId))) {
        return options.methods.saveConvo(ctx, data, metadata);
      }
      const saved = await store.saveConversation(appUserId, userId, {
        conversationId,
        title: data.title,
        model: data.model,
        endpoint: data.endpoint,
        extra: extraFrom(data),
        noUpsert: metadata?.noUpsert,
      });
      return saved ? presentConversation(saved) : null;
    },

    async deleteConvos(
      user: string,
      filter: DeleteFilter,
      deleteOptions?: unknown,
    ): Promise<{ deletedCount?: number; conversationIds?: string[]; messages?: { deletedCount?: number } }> {
      const appUserId = await ownerId(user);
      const ids = conversationIds(filter.conversationId);
      if (!appUserId || (ids == null && filter.conversationId != null)) {
        return options.methods.deleteConvos(user, filter, deleteOptions);
      }
      await store.deleteConversations(appUserId, ids);
      return options.methods.deleteConvos(user, filter, deleteOptions);
    },

    async getMessages(filter: MessageFilter, select?: string): Promise<unknown[]> {
      const user = typeof filter.user === 'string' ? filter.user : '';
      const conversationId = typeof filter.conversationId === 'string' ? filter.conversationId : '';
      const appUserId = user ? await ownerId(user) : null;
      if (!appUserId || !isChatUuid(conversationId)) {
        return options.methods.getMessages(filter, select);
      }
      try {
        const stored = await store.listMessages(appUserId, user, conversationId);
        if (stored.length === 0) return options.methods.getMessages(filter, select);
        const messageId = typeof filter.messageId === 'string' ? filter.messageId : '';
        const matched = messageId ? stored.filter((item) => item.messageId === messageId) : stored;
        return matched.map(presentMessage);
      } catch (error) {
        const legacy = await options.methods.getMessages(filter, select);
        if (legacy.length > 0) return legacy;
        const message = error instanceof Error ? error.message : 'Could not load messages';
        throw new Error(message);
      }
    },

    async saveMessage(ctx: SaveContext, params: MessageData, metadata?: unknown): Promise<unknown> {
      const userId = ctx.userId ?? '';
      const conversationId = params.conversationId ?? '';
      const messageId = params.newMessageId || params.messageId || '';
      if (!userId || ctx.isTemporary || !isChatUuid(conversationId) || !isChatUuid(messageId)) {
        return options.methods.saveMessage(ctx, params, metadata);
      }
      const appUserId = await ownerId(userId);
      if (!appUserId || (await isSubagent(userId, conversationId))) {
        return options.methods.saveMessage(ctx, params, metadata);
      }
      const saved = await store.saveMessage(appUserId, userId, {
        messageId,
        conversationId,
        parentMessageId: params.parentMessageId,
        sender: params.sender ?? (params.isCreatedByUser ? 'User' : null),
        text: params.text,
        payload: extraFrom(params, SKIPPED_MESSAGE_KEYS),
      });
      return saved ? presentMessage(saved) : options.methods.saveMessage(ctx, params, metadata);
    },

    async deleteMessages(filter: MessageFilter): Promise<unknown> {
      const user = typeof filter.user === 'string' ? filter.user : '';
      const conversationId = typeof filter.conversationId === 'string' ? filter.conversationId : '';
      const appUserId = user ? await ownerId(user) : null;
      if (appUserId && (!conversationId || isChatUuid(conversationId))) {
        await store.deleteMessages(appUserId, conversationId || null);
      }
      return options.methods.deleteMessages(filter);
    },
  };
}

function presentConversation(stored: StoredConversation) {
  const extra = objectValue(stored.extra);
  return {
    ...extra,
    conversationId: stored.conversationId,
    user: stored.user,
    title: stored.title,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.model ? { model: stored.model } : {}),
    ...(stored.endpoint ? { endpoint: stored.endpoint } : {}),
  };
}

function presentMessage(stored: StoredChatMessage) {
  return {
    ...objectValue(stored.payload),
    messageId: stored.messageId,
    conversationId: stored.conversationId,
    user: stored.user,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.parentMessageId ? { parentMessageId: stored.parentMessageId } : {}),
    ...(stored.sender ? { sender: stored.sender } : {}),
    ...(stored.text != null ? { text: stored.text } : {}),
  };
}

function extraFrom(data: object, skipped = SKIPPED_CONVO_KEYS): JsonValue | undefined {
  const extra: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(data)) {
    if (skipped.has(key) || value == null) continue;
    const json = toJson(value);
    if (json !== undefined) extra[key] = json;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value == null || typeof value === 'function') return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

function objectValue(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function conversationIds(value: unknown): string[] | null {
  if (value == null) return null;
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value && '$in' in value && Array.isArray(value.$in)) {
    return value.$in.filter((item): item is string => typeof item === 'string');
  }
  return null;
}

type ListCursor = { v: string | null; m: string | null };

type MergeRow = {
  source: 'v' | 'm';
  item: unknown;
  updatedAt: string;
  id: string;
};

function clampPage(limit: number | undefined): number {
  if (!limit || limit < 1) return 25;
  return Math.min(Math.trunc(limit), 100);
}

function decodeListCursor(cursor: string | null | undefined): ListCursor {
  if (!cursor) return { v: null, m: null };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      v?: unknown;
      m?: unknown;
      primary?: unknown;
    };
    if (parsed && typeof parsed === 'object' && !('primary' in parsed) && ('v' in parsed || 'm' in parsed)) {
      return {
        v: typeof parsed.v === 'string' ? sanitizeConversationCursor(parsed.v) : null,
        m: typeof parsed.m === 'string' ? parsed.m : null,
      };
    }
  } catch {
    // Not a composite cursor.
  }
  if (cursor.includes('|') || sanitizeConversationCursor(cursor)) {
    return { v: sanitizeConversationCursor(cursor), m: null };
  }
  return { v: null, m: cursor };
}

function encodeListCursor(cursor: ListCursor): string | null {
  if (!cursor.v && !cursor.m) return null;
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

function mergeConversationPages(
  vectoreePage: { conversations: StoredConversation[]; nextCursor: string | null },
  mongoPage: { conversations: unknown[]; nextCursor: string | null },
  incoming: ListCursor,
  limit: number,
): { conversations: unknown[]; nextCursor: string | null } {
  const seen = new Set<string>();
  const rows: MergeRow[] = [];
  for (const item of vectoreePage.conversations) {
    seen.add(item.conversationId);
    rows.push({
      source: 'v',
      item: presentConversation(item),
      updatedAt: item.updatedAt,
      id: item.conversationId,
    });
  }
  let duplicateMongo = 0;
  for (const item of mongoPage.conversations) {
    const id = conversationIdOf(item);
    if (id && seen.has(id)) {
      duplicateMongo += 1;
      continue;
    }
    rows.push({
      source: 'm',
      item,
      updatedAt: stampOf(recordField(item, 'updatedAt')),
      id,
    });
  }
  rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  const page = rows.slice(0, limit);
  const rest = rows.slice(limit);
  const mongoFetched = mongoPage.conversations.length;
  const mongoKept = rows.filter((row) => row.source === 'm').length;
  return {
    conversations: page.map((row) => row.item),
    nextCursor: encodeListCursor({
      v: nextSourceCursor(
        page.filter((row) => row.source === 'v'),
        rest.some((row) => row.source === 'v'),
        rest.length > 0,
        vectoreePage.nextCursor,
        incoming.v,
        (row) => `${row.updatedAt}|${row.id}`,
      ),
      m: nextMongoCursor(
        page,
        rest,
        rest.length > 0,
        mongoPage.nextCursor,
        incoming.m,
        mongoFetched,
        mongoKept,
        duplicateMongo,
      ),
    }),
  };
}

function nextSourceCursor(
  included: MergeRow[],
  hasLeftover: boolean,
  moreRemains: boolean,
  sourceNext: string | null,
  incoming: string | null,
  cursorOf: (row: MergeRow) => string,
): string | null {
  if (hasLeftover) {
    const last = included[included.length - 1];
    return last ? cursorOf(last) : incoming;
  }
  if (included.length === 0) return incoming;
  if (sourceNext) return sourceNext;
  if (!moreRemains) return null;
  return cursorOf(included[included.length - 1]);
}

function nextMongoCursor(
  page: MergeRow[],
  rest: MergeRow[],
  moreRemains: boolean,
  sourceNext: string | null,
  incoming: string | null,
  fetched: number,
  kept: number,
  duplicates: number,
): string | null {
  if (fetched > 0 && kept === 0 && duplicates === fetched) return sourceNext;
  const included = page.filter((row) => row.source === 'm');
  const hasLeftover = rest.some((row) => row.source === 'm');
  if (hasLeftover) {
    const last = included[included.length - 1];
    return last ? mongoCursorAfter(last.item) ?? incoming : incoming;
  }
  if (included.length === 0) return incoming;
  if (sourceNext) return sourceNext;
  if (!moreRemains) return null;
  const last = included[included.length - 1];
  return last ? mongoCursorAfter(last.item) : null;
}

function mongoCursorAfter(item: unknown): string | null {
  const updatedAt = stampOf(recordField(item, 'updatedAt'));
  const id = recordField(item, '_id');
  const mongoId = id == null ? '' : String(id);
  if (!updatedAt || !mongoId) return null;
  return Buffer.from(JSON.stringify({ primary: updatedAt, secondary: updatedAt, id: mongoId })).toString('base64');
}

function conversationIdOf(item: unknown): string {
  const id = recordField(item, 'conversationId');
  return typeof id === 'string' ? id : '';
}

function recordField(item: unknown, key: string): unknown {
  if (!item || typeof item !== 'object') return undefined;
  return (item as { [key: string]: unknown })[key];
}

function stampOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : '';
}
