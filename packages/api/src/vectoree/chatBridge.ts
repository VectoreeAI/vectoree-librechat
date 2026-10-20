import type { JsonValue, StoredChatMessage, StoredConversation } from './chats';
import type { VectoreeAppCredentials } from './appAuth';
import { createVectoreeChats, isChatUuid } from './chats';

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
  fetchImpl?: typeof fetch;
}): VectoreeChatBridge {
  const store = createVectoreeChats({
    credentials: options.credentials,
    fetchImpl: options.fetchImpl,
  });
  const owners = new Map<string, string | null>();

  async function ownerId(userId: string): Promise<string | null> {
    if (!options.credentials()?.apiKey) return null;
    if (owners.has(userId)) return owners.get(userId) ?? null;
    const appUserId = await options.findOwner(userId);
    owners.set(userId, appUserId);
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
      const page = await store.listConversations(appUserId, user, {
        limit: query?.limit,
        cursor: query?.cursor,
        search: query?.search,
      });
      return {
        conversations: page.conversations.map(presentConversation),
        nextCursor: page.nextCursor,
      };
    },

    async getConvo(user: string, conversationId: string): Promise<unknown> {
      const appUserId = await ownerId(user);
      if (!appUserId || !isChatUuid(conversationId)) {
        return options.methods.getConvo(user, conversationId);
      }
      const stored = await store.getConversation(appUserId, user, conversationId);
      if (stored) return presentConversation(stored);
      return options.methods.getConvo(user, conversationId);
    },

    async getConvoTitle(user: string, conversationId: string): Promise<string | null> {
      const appUserId = await ownerId(user);
      if (!appUserId || !isChatUuid(conversationId)) {
        return options.methods.getConvoTitle(user, conversationId);
      }
      const stored = await store.getConversation(appUserId, user, conversationId);
      if (stored) return stored.title;
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
      const stored = await store.listMessages(appUserId, user, conversationId);
      if (stored.length === 0) return options.methods.getMessages(filter, select);
      const messageId = typeof filter.messageId === 'string' ? filter.messageId : '';
      const matched = messageId ? stored.filter((item) => item.messageId === messageId) : stored;
      return matched.map(presentMessage);
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
