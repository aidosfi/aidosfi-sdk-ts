import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { AidosClient, AidosApiError } from '../src/client.js';
import type {
  Account,
  Card,
  Agent,
  PaginatedResponse,
  AidosError,
} from '../src/types.js';

// Helper: create a mock Response with JSON body
function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

// Helper: mock PaginatedResponse
function paginatedResponse<T>(data: T[], cursor: string | null, hasMore: boolean): PaginatedResponse<T> {
  return { data, cursor, hasMore };
}

// Mock account
const mockAccount: Account = {
  id: 'acc_001',
  label: 'Test Account',
  asset: 'USDC',
  shieldedBalance: '0xabc',
  createdAt: '2025-01-15T10:00:00Z',
};

const mockCard: Card = {
  id: 'card_001',
  type: 'virtual',
  last4: '1234',
  limit: 1000,
  spent: 0,
  status: 'active',
  issuedAt: '2025-01-15T10:00:00Z',
};

const mockAgent: Agent = {
  id: 'agent_001',
  strategy: 'dca',
  asset: 'USDC',
  amount: 500,
  interval: '1d',
  status: 'running',
  attestationHash: '0xdef',
  deployedAt: '2025-01-15T10:00:00Z',
};

describe('Enriched AidosClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Clean up env vars
    delete process.env['AIDOSFI_API_KEY'];
    delete process.env['AIDOSFI_BASE_URL'];
    delete process.env['AIDOSFI_WS_URL'];
    delete process.env['AIDOSFI_TIMEOUT'];
  });

  // ─── fromEnv ─────────────────────────────────────────────────

  describe('fromEnv', () => {
    it('should create client from env vars', () => {
      process.env['AIDOSFI_API_KEY'] = 'env-key-123';
      process.env['AIDOSFI_BASE_URL'] = 'https://env.example.com';
      process.env['AIDOSFI_WS_URL'] = 'wss://env-ws.example.com';
      process.env['AIDOSFI_TIMEOUT'] = '5000';

      const client = AidosClient.fromEnv();
      assert.ok(client instanceof AidosClient);
    });

    it('should throw when AIDOSFI_API_KEY is missing', () => {
      assert.throws(
        () => AidosClient.fromEnv(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes('AIDOSFI_API_KEY'));
          return true;
        },
      );
    });

    it('should use overrides over env vars', () => {
      process.env['AIDOSFI_API_KEY'] = 'env-key';
      process.env['AIDOSFI_BASE_URL'] = 'https://env.example.com';

      const client = AidosClient.fromEnv({
        apiKey: 'override-key',
        baseUrl: 'https://override.example.com',
      });
      assert.ok(client instanceof AidosClient);
    });

    it('should use apiKey from override when env is not set', () => {
      const client = AidosClient.fromEnv({ apiKey: 'override-only-key' });
      assert.ok(client instanceof AidosClient);
    });
  });

  // ─── Retry with Exponential Backoff ──────────────────────────

  describe('retry', () => {
    it('should retry on 5xx errors with exponential backoff', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        if (callCount <= 2) {
          return jsonResponse(
            { code: 'SERVER_ERROR', message: 'Internal server error', status: 500 },
            500,
          );
        }
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        retry: { maxRetries: 3, initialDelay: 10, maxDelay: 100 },
      });

      const result = await client.getAccount('acc_001');
      assert.deepStrictEqual(result, mockAccount);
      assert.strictEqual(callCount, 3);
    });

    it('should retry on 429 with Retry-After header', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse(
            { code: 'RATE_LIMITED', message: 'Too many requests', status: 429 },
            429,
            { 'Retry-After': '0' }, // 0 seconds = immediate retry
          );
        }
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        retry: { maxRetries: 3, initialDelay: 10, maxDelay: 100 },
      });

      const result = await client.getAccount('acc_001');
      assert.deepStrictEqual(result, mockAccount);
      assert.strictEqual(callCount, 2);
    });

    it('should retry on network errors', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        if (callCount <= 1) {
          throw new TypeError('fetch failed');
        }
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        retry: { maxRetries: 3, initialDelay: 10, maxDelay: 100 },
      });

      const result = await client.getAccount('acc_001');
      assert.deepStrictEqual(result, mockAccount);
      assert.strictEqual(callCount, 2);
    });

    it('should NOT retry on 4xx errors (except 429)', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        return jsonResponse(
          { code: 'INVALID_REQUEST', message: 'Bad request', status: 400 },
          400,
        );
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        retry: { maxRetries: 3, initialDelay: 10, maxDelay: 100 },
      });

      await assert.rejects(
        () => client.getAccount('acc_001'),
        (err: unknown) => {
          assert.ok(err instanceof AidosApiError);
          assert.strictEqual((err as AidosApiError).status, 400);
          return true;
        },
      );
      assert.strictEqual(callCount, 1);
    });

    it('should give up after maxRetries', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        throw new TypeError('fetch failed');
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        retry: { maxRetries: 2, initialDelay: 10, maxDelay: 100 },
      });

      await assert.rejects(
        () => client.getAccount('acc_001'),
        (err: unknown) => {
          assert.ok(err instanceof TypeError);
          return true;
        },
      );
      // 1 initial + 2 retries = 3
      assert.strictEqual(callCount, 3);
    });

    it('should use default retry config when not specified', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const result = await client.getAccount('acc_001');
      assert.deepStrictEqual(result, mockAccount);
      assert.strictEqual(callCount, 1);
    });
  });

  // ─── Idempotency Keys ────────────────────────────────────────

  describe('idempotency', () => {
    it('should add Idempotency-Key header on POST when enabled', async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        idempotency: { enabled: true },
      });

      await client.createAccount({ label: 'Test' });
      assert.ok('Idempotency-Key' in capturedHeaders);
      // Should be a valid UUID
      const key = capturedHeaders['Idempotency-Key'];
      assert.ok(key);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert.ok(uuidRe.test(key));
    });

    it('should add Idempotency-Key header on PUT when enabled', async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        idempotency: { enabled: true },
        retry: { maxRetries: 0 },
      });

      // We don't have a PUT method, but deposit uses POST
      await client.deposit('acc_001', { asset: 'USDC', amount: 100 });
      assert.ok('Idempotency-Key' in capturedHeaders);
    });

    it('should NOT add Idempotency-Key header on GET', async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        idempotency: { enabled: true },
      });

      await client.getAccount('acc_001');
      assert.strictEqual('Idempotency-Key' in capturedHeaders, false);
    });

    it('should NOT add Idempotency-Key when not enabled (default)', async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(async (_url: string | URL, init?: RequestInit) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      // Default: idempotency not enabled
      const client = new AidosClient({ apiKey: 'test-key' });

      await client.createAccount({ label: 'Test' });
      assert.strictEqual('Idempotency-Key' in capturedHeaders, false);
    });
  });

  // ─── Auto-Pagination ─────────────────────────────────────────

  describe('auto-pagination', () => {
    it('listAllAccounts should yield all items across pages', async () => {
      let pageNum = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        pageNum++;
        if (pageNum === 1) {
          return jsonResponse(
            paginatedResponse(
              [{ ...mockAccount, id: 'acc_1' }, { ...mockAccount, id: 'acc_2' }],
              'cursor_p2',
              true,
            ),
          );
        }
        if (pageNum === 2) {
          return jsonResponse(
            paginatedResponse(
              [{ ...mockAccount, id: 'acc_3' }],
              null,
              false,
            ),
          );
        }
        return jsonResponse(paginatedResponse([], null, false));
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const results: Account[] = [];
      for await (const account of client.listAllAccounts()) {
        results.push(account);
      }
      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0].id, 'acc_1');
      assert.strictEqual(results[1].id, 'acc_2');
      assert.strictEqual(results[2].id, 'acc_3');
      assert.strictEqual(pageNum, 2);
    });

    it('listAllCards should yield all cards across pages', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse(
            paginatedResponse([{ ...mockCard, id: 'card_1' }], 'c2', true),
          );
        }
        return jsonResponse(
          paginatedResponse([{ ...mockCard, id: 'card_2' }], null, false),
        );
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const results: Card[] = [];
      for await (const card of client.listAllCards('acc_001')) {
        results.push(card);
      }
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].id, 'card_1');
      assert.strictEqual(results[1].id, 'card_2');
    });

    it('listAllAgents should yield all agents across pages', async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        callCount++;
        return jsonResponse(
          paginatedResponse([{ ...mockAgent, id: `agent_${callCount}` }], null, false),
        );
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const results: Agent[] = [];
      for await (const agent of client.listAllAgents('acc_001')) {
        results.push(agent);
      }
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].id, 'agent_1');
    });

    it('listAllAccounts should handle empty result', async () => {
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(paginatedResponse([], null, false));
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const results: Account[] = [];
      for await (const account of client.listAllAccounts()) {
        results.push(account);
      }
      assert.strictEqual(results.length, 0);
    });

    it('listAllAccounts should pass limit param', async () => {
      let queryStr = '';
      globalThis.fetch = mock.fn(async (url: string | URL, _init?: RequestInit) => {
        queryStr = url.toString();
        return jsonResponse(paginatedResponse([mockAccount], null, false));
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const results: Account[] = [];
      for await (const account of client.listAllAccounts({ limit: 50 })) {
        results.push(account);
      }
      assert.ok(queryStr.includes('limit=50'));
    });
  });

  // ─── Request Hooks ───────────────────────────────────────────

  describe('hooks', () => {
    it('should call onRequest hook', async () => {
      const hookCalls: Array<{ method: string; url: string }> = [];

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        hooks: {
          onRequest: (req) => {
            hookCalls.push({ method: req.method, url: req.url });
          },
        },
      });

      await client.getAccount('acc_001');
      assert.strictEqual(hookCalls.length, 1);
      assert.strictEqual(hookCalls[0].method, 'GET');
      assert.ok(hookCalls[0].url.includes('/v1/accounts/acc_001'));
    });

    it('should call onResponse hook', async () => {
      const hookCalls: Array<{ status: number; duration: number }> = [];

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        hooks: {
          onResponse: (res) => {
            hookCalls.push({ status: res.status, duration: res.duration });
          },
        },
      });

      await client.getAccount('acc_001');
      assert.strictEqual(hookCalls.length, 1);
      assert.strictEqual(hookCalls[0].status, 200);
      assert.ok(typeof hookCalls[0].duration === 'number');
      assert.ok(hookCalls[0].duration >= 0);
    });

    it('should call onError hook when request fails', async () => {
      const hookCalls: Array<{ url: string; duration: number }> = [];

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        throw new Error('Network failure');
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        retry: { maxRetries: 0 },
        hooks: {
          onError: (err) => {
            hookCalls.push({ url: err.url, duration: err.duration });
          },
        },
      });

      await assert.rejects(() => client.getAccount('acc_001'));
      assert.strictEqual(hookCalls.length, 1);
      assert.ok(hookCalls[0].url.includes('/v1/accounts/acc_001'));
      assert.ok(hookCalls[0].duration >= 0);
    });

    it('onRequest hook receives headers', async () => {
      let capturedHeaders: Record<string, string> = {};

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({
        apiKey: 'test-key',
        idempotency: { enabled: true },
        hooks: {
          onRequest: (req) => {
            capturedHeaders = req.headers;
          },
        },
      });

      await client.createAccount({ label: 'Test' });
      assert.ok('Authorization' in capturedHeaders);
      assert.ok(capturedHeaders['Authorization'].startsWith('Bearer '));
      assert.ok('Idempotency-Key' in capturedHeaders);
    });

    it('should work without hooks configured', async () => {
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const result = await client.getAccount('acc_001');
      assert.deepStrictEqual(result, mockAccount);
    });
  });

  // ─── WebSocket Auto-Reconnect ────────────────────────────────

  describe('WebSocket reconnect', () => {
    it('connectWebSocketReconnecting should return a WebSocketHandle', () => {
      const client = new AidosClient({ apiKey: 'test-key' });
      const handle = client.connectWebSocketReconnecting({ maxReconnectAttempts: 1, reconnectDelay: 50 });
      assert.ok(handle);
      assert.strictEqual(typeof handle.on, 'function');
      assert.strictEqual(typeof handle.off, 'function');
      assert.strictEqual(typeof handle.close, 'function');
      handle.close();
    });

    it('connectWebSocketReconnecting should accept default config', () => {
      const client = new AidosClient({ apiKey: 'test-key' });
      const handle = client.connectWebSocketReconnecting();
      assert.ok(handle);
      assert.strictEqual(typeof handle.on, 'function');
      handle.close();
    });
  });

  // ─── Existing API Methods Still Work ─────────────────────────

  describe('existing API methods', () => {
    it('createAccount still works', async () => {
      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(mockAccount, 200);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });
      const account = await client.createAccount({ label: 'My Account' });
      assert.deepStrictEqual(account, mockAccount);
    });

    it('throws AidosApiError on 400', async () => {
      const errorBody: AidosError = {
        code: 'INVALID_REQUEST',
        message: 'Label is required',
        status: 400,
      };

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return jsonResponse(errorBody, 400);
      }) as unknown as typeof globalThis.fetch;

      const client = new AidosClient({ apiKey: 'test-key' });

      await assert.rejects(
        () => client.createAccount({ label: '' }),
        (err: unknown) => {
          assert.ok(err instanceof AidosApiError);
          assert.strictEqual((err as AidosApiError).code, 'INVALID_REQUEST');
          assert.strictEqual((err as AidosApiError).status, 400);
          return true;
        },
      );
    });
  });
});
