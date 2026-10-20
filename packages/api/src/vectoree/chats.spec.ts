import type { VectoreeChatMongo } from './chatBridge';
import { createVectoreeChatBridge } from './chatBridge';
import { createVectoreeChats } from './chats';

const API = 'https://vectoree.ai';
const KEY = 'sk-ve-v1-test-key';
const CONVO = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('vectoree chats', () => {
  test('creates the project tables and stores a chat with its message', async () => {
    const tables = new Set<string>();
    const conversations: Array<Record<string, unknown>> = [];
    const messages: Array<Record<string, unknown>> = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/database/tables' && method === 'GET') return jsonResponse([...tables]);
      if (path === '/api/database/tables' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { tableName: string };
        tables.add(body.tableName);
        return jsonResponse({ tableName: body.tableName }, 201);
      }
      if (path === '/api/database/records/librechat_conversations' && method === 'GET') {
        return jsonResponse(conversations);
      }
      if (path === '/api/database/records/librechat_conversations' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const row = { ...body, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' };
        conversations.push(row);
        return jsonResponse([row], 201);
      }
      if (path === '/api/database/records/librechat_messages' && method === 'GET') return jsonResponse(messages);
      if (path === '/api/database/records/librechat_messages' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const row = { ...body, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' };
        messages.push(row);
        return jsonResponse([row], 201);
      }
      return jsonResponse({ message: 'missing' }, 404);
    });
    const chats = createVectoreeChats({
      credentials: () => ({ apiUrl: API, apiKey: KEY }),
      fetchImpl,
    });
    const saved = await chats.saveConversation('app-user', 'mongo-user', {
      conversationId: CONVO,
      title: 'Hello',
      endpoint: 'Vectoree',
      model: 'vectoree/auto',
      extra: { agent_id: 'agent-1' },
    });
    expect(saved).toMatchObject({
      conversationId: CONVO,
      user: 'mongo-user',
      title: 'Hello',
      endpoint: 'Vectoree',
      model: 'vectoree/auto',
    });
    expect(tables.has('librechat_conversations')).toBe(true);
    expect(tables.has('librechat_messages')).toBe(true);
    const message = await chats.saveMessage('app-user', 'mongo-user', {
      messageId: MESSAGE,
      conversationId: CONVO,
      sender: 'User',
      text: 'hi',
      payload: { isCreatedByUser: true },
    });
    expect(message).toMatchObject({ messageId: MESSAGE, text: 'hi', user: 'mongo-user' });
    const page = await chats.listConversations('app-user', 'mongo-user', {});
    expect(page.conversations).toHaveLength(1);
    const loaded = await chats.listMessages('app-user', 'mongo-user', CONVO);
    expect(loaded[0]?.text).toBe('hi');
  });
});

describe('vectoree chat bridge', () => {
  test('keeps a subagent thread on mongo and writes a normal chat to vectoree', async () => {
    const mongoSave = jest.fn(async () => ({ conversationId: 'mongo' }));
    const methods: VectoreeChatMongo = {
      getConvosByCursor: jest.fn(async () => ({ conversations: [], nextCursor: null })),
      getConvo: jest.fn(async (_user: string, conversationId: string) =>
        conversationId === CONVO ? null : { subagentThread: { depth: 1 } },
      ),
      getConvoTitle: jest.fn(async () => null),
      saveConvo: mongoSave,
      deleteConvos: jest.fn(async () => ({ deletedCount: 0, conversationIds: [] })),
      getMessages: jest.fn(async () => []),
      saveMessage: jest.fn(async () => null),
      deleteMessages: jest.fn(async () => ({ deletedCount: 0 })),
    };
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/database/tables' && method === 'GET') {
        return jsonResponse(['librechat_conversations', 'librechat_messages']);
      }
      if (path.startsWith('/api/database/records/') && method === 'GET') return jsonResponse([]);
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse([{ ...body, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }], 201);
      }
      return jsonResponse({ message: 'missing' }, 404);
    });
    const bridge = createVectoreeChatBridge({
      methods,
      credentials: () => ({ apiUrl: API, apiKey: KEY }),
      findOwner: async () => 'app-user',
      fetchImpl,
    });
    await bridge.saveConvo({ userId: 'mongo-user' }, { conversationId: 'child', subagentThread: { depth: 1 } });
    expect(mongoSave).toHaveBeenCalledTimes(1);
    const saved = await bridge.saveConvo(
      { userId: 'mongo-user' },
      { conversationId: CONVO, title: 'Vectoree chat', endpoint: 'Vectoree', model: 'vectoree/auto' },
    );
    expect(saved).toMatchObject({ conversationId: CONVO, title: 'Vectoree chat', user: 'mongo-user' });
    expect(mongoSave).toHaveBeenCalledTimes(1);
  });
});
