import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { AidosClient, AidosApiError } from '../src/client.js';
import type { Account, AidosError } from '../src/types.js';

describe('AidosClient', () => {
  let client: AidosClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    client = new AidosClient({ apiKey: 'test-key-123' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should construct with correct defaults', () => {
    assert.strictEqual(client instanceof AidosClient, true);
  });

  it('should accept custom baseUrl and wsUrl', () => {
    const c = new AidosClient({
      apiKey: 'k',
      baseUrl: 'https://custom.example.com',
      wsUrl: 'wss://custom-ws.example.com',
    });
    // Construction succeeds without throwing
    assert.ok(c instanceof AidosClient);
  });

  describe('createAccount', () => {
    it('should return an Account on success', async () => {
      const mockAccount: Account = {
        id: 'acc_001',
        label: 'My Account',
        asset: 'USDC',
        shieldedBalance: '0xabc123',
        createdAt: '2025-01-15T10:00:00Z',
      };

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return new Response(JSON.stringify(mockAccount), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const account = await client.createAccount({ label: 'My Account' });
      assert.deepStrictEqual(account, mockAccount);
    });

    it('should throw AidosApiError on error response', async () => {
      const errorBody: AidosError = {
        code: 'INVALID_REQUEST',
        message: 'Label is required',
        status: 400,
      };

      globalThis.fetch = mock.fn(async (_url: string | URL, _init?: RequestInit) => {
        return new Response(JSON.stringify(errorBody), { status: 400 });
      }) as unknown as typeof globalThis.fetch;

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
