import {
  AidosConfig,
  AidosError,
  Account,
  CreateAccountRequest,
  DepositRequest,
  DepositReceipt,
  IssueCardRequest,
  Card,
  DeployAgentRequest,
  Agent,
  SpendRequest,
  SpendReceipt,
  SwapRequest,
  SwapReceipt,
  HealthResponse,
  PaginationParams,
  PaginatedResponse,
  WsEvent,
  RetryConfig,
  IdempotencyConfig,
  HooksConfig,
  ReconnectConfig,
} from './types.js';

class AidosApiError extends Error {
  public code: string;
  public message: string;
  public status: number;
  public details?: unknown;

  constructor(error: AidosError) {
    super(error.message);
    this.name = 'AidosApiError';
    this.code = error.code;
    this.message = error.message;
    this.status = error.status;
    this.details = error.details;
  }
}

export interface WebSocketHandle {
  on: (event: WsEvent['type'], handler: (data: WsEvent) => void) => void;
  off: (event: WsEvent['type'], handler: (data: WsEvent) => void) => void;
  close: () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(delayMs: number): number {
  const factor = 0.75 + Math.random() * 0.5; // ±25%
  return Math.round(delayMs * factor);
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class AidosClient {
  private apiKey: string;
  private baseUrl: string;
  private wsUrl: string;
  private timeout: number;
  private retry: RetryConfig;
  private idempotency: IdempotencyConfig;
  private hooks: HooksConfig;

  constructor(config: AidosConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.aidosfi.com';
    this.wsUrl = config.wsUrl ?? 'wss://ws.aidosfi.com';
    this.timeout = config.timeout ?? 30_000;
    this.retry = {
      maxRetries: config.retry?.maxRetries ?? 3,
      initialDelay: config.retry?.initialDelay ?? 300,
      maxDelay: config.retry?.maxDelay ?? 10_000,
    };
    this.idempotency = {
      enabled: config.idempotency?.enabled ?? false,
    };
    this.hooks = {
      onRequest: config.hooks?.onRequest,
      onResponse: config.hooks?.onResponse,
      onError: config.hooks?.onError,
    };
  }

  // ── Static: fromEnv ───────────────────────────────────────────

  static fromEnv(overrides?: Partial<AidosConfig>): AidosClient {
    const apiKey = overrides?.apiKey ?? process.env['AIDOSFI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'AIDOSFI_API_KEY environment variable is required. ' +
        'Set it in your environment or pass it via overrides.'
      );
    }

    return new AidosClient({
      apiKey,
      baseUrl: overrides?.baseUrl ?? process.env['AIDOSFI_BASE_URL'],
      wsUrl: overrides?.wsUrl ?? process.env['AIDOSFI_WS_URL'],
      timeout: overrides?.timeout ?? (process.env['AIDOSFI_TIMEOUT'] ? Number(process.env['AIDOSFI_TIMEOUT']) : undefined),
      retry: overrides?.retry,
      idempotency: overrides?.idempotency,
      hooks: overrides?.hooks,
    });
  }

  // ── Core request with retry, idempotency, hooks ──────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = this.retry.maxRetries ?? 3;
    const initialDelay = this.retry.initialDelay ?? 300;
    const maxDelay = this.retry.maxDelay ?? 10_000;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      try {
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        };

        // Idempotency key for mutating requests
        if (this.idempotency.enabled && (method === 'POST' || method === 'PUT') && body !== undefined) {
          headers['Idempotency-Key'] = crypto.randomUUID();
        }

        // Hook: onRequest
        if (this.hooks.onRequest) {
          this.hooks.onRequest({ method, url, headers });
        }

        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        const duration = Date.now() - startTime;

        // Hook: onResponse
        if (this.hooks.onResponse) {
          this.hooks.onResponse({ status: response.status, url, duration });
        }

        if (!response.ok) {
          let errorBody: AidosError;
          try {
            errorBody = await response.json() as AidosError;
          } catch {
            errorBody = {
              code: 'UNKNOWN',
              message: `HTTP ${response.status}: ${response.statusText}`,
              status: response.status,
            };
          }

          // Respect Retry-After header for 429
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            if (retryAfter && attempt < maxRetries) {
              const waitSeconds = parseInt(retryAfter, 10);
              if (!isNaN(waitSeconds)) {
                await delay(waitSeconds * 1000);
                continue;
              }
            }
          }

          // Retry on 5xx or 429
          if (isRetryableStatus(response.status) && attempt < maxRetries) {
            const delayMs = clamp(
              jitter(initialDelay * Math.pow(2, attempt)),
              0,
              maxDelay,
            );
            await delay(delayMs);
            lastError = new AidosApiError(errorBody);
            continue;
          }

          throw new AidosApiError(errorBody);
        }

        if (response.status === 204) {
          return undefined as unknown as T;
        }

        return await response.json() as T;
      } catch (err: unknown) {
        clearTimeout(timer);
        const duration = Date.now() - startTime;
        const isNetworkError = err instanceof TypeError ||
          (err instanceof DOMException && err.name === 'AbortError');

        // Hook: onError (only on last attempt or non-retryable)
        if (attempt >= maxRetries && this.hooks.onError) {
          this.hooks.onError({ error: err instanceof Error ? err : new Error(String(err)), url, duration });
        }

        if ((isNetworkError || (err instanceof AidosApiError && isRetryableStatus(err.status))) && attempt < maxRetries) {
          const delayMs = clamp(
            jitter(initialDelay * Math.pow(2, attempt)),
            0,
            maxDelay,
          );
          await delay(delayMs);
          lastError = err instanceof Error ? err : new Error(String(err));
          continue;
        }

        if (err instanceof AidosApiError) {
          throw err;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastError instanceof AidosApiError) {
      throw lastError;
    }
    throw lastError ?? new Error('Request failed after retries');
  }

  // ── Health ─────────────────────────────────────────────────────

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/v1/health');
  }

  // ── Account ──────────────────────────────────────────────────

  async createAccount(req: CreateAccountRequest): Promise<Account> {
    return this.request<Account>('POST', '/v1/accounts', req);
  }

  async getAccount(accountId: string): Promise<Account> {
    return this.request<Account>('GET', `/v1/accounts/${accountId}`);
  }

  async listAccounts(params?: PaginationParams): Promise<PaginatedResponse<Account>> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.cursor) query.set('cursor', params.cursor);
    const qs = query.toString();
    return this.request<PaginatedResponse<Account>>('GET', `/v1/accounts${qs ? `?${qs}` : ''}`);
  }

  // ── Auto-pagination ──────────────────────────────────────────

  async *listAllAccounts(params?: Omit<PaginationParams, 'cursor'>): AsyncIterable<Account> {
    let cursor: string | undefined;
    const limit = params?.limit;
    while (true) {
      const page = await this.listAccounts({ limit, cursor });
      for (const item of page.data) {
        yield item;
      }
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
  }

  async *listAllCards(accountId: string, params?: Omit<PaginationParams, 'cursor'>): AsyncIterable<Card> {
    let cursor: string | undefined;
    const limit = params?.limit;
    while (true) {
      const query = new URLSearchParams();
      if (limit) query.set('limit', String(limit));
      if (cursor) query.set('cursor', cursor);
      const qs = query.toString();
      const page = await this.request<PaginatedResponse<Card>>(
        'GET',
        `/v1/accounts/${accountId}/cards${qs ? `?${qs}` : ''}`,
      );
      for (const item of page.data) {
        yield item;
      }
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
  }

  async *listAllAgents(accountId: string, params?: Omit<PaginationParams, 'cursor'>): AsyncIterable<Agent> {
    let cursor: string | undefined;
    const limit = params?.limit;
    while (true) {
      const query = new URLSearchParams();
      if (limit) query.set('limit', String(limit));
      if (cursor) query.set('cursor', cursor);
      const qs = query.toString();
      const page = await this.request<PaginatedResponse<Agent>>(
        'GET',
        `/v1/accounts/${accountId}/agents${qs ? `?${qs}` : ''}`,
      );
      for (const item of page.data) {
        yield item;
      }
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
  }

  // ── Deposit ──────────────────────────────────────────────────

  async deposit(accountId: string, req: DepositRequest): Promise<DepositReceipt> {
    return this.request<DepositReceipt>('POST', `/v1/accounts/${accountId}/deposit`, req);
  }

  // ── Card ─────────────────────────────────────────────────────

  async issueCard(accountId: string, req: IssueCardRequest): Promise<Card> {
    return this.request<Card>('POST', `/v1/accounts/${accountId}/cards`, req);
  }

  async getCard(cardId: string): Promise<Card> {
    return this.request<Card>('GET', `/v1/cards/${cardId}`);
  }

  async freezeCard(cardId: string): Promise<Card> {
    return this.request<Card>('POST', `/v1/cards/${cardId}/freeze`);
  }

  async unfreezeCard(cardId: string): Promise<Card> {
    return this.request<Card>('POST', `/v1/cards/${cardId}/unfreeze`);
  }

  async spend(cardId: string, req: SpendRequest): Promise<SpendReceipt> {
    return this.request<SpendReceipt>('POST', `/v1/cards/${cardId}/spend`, req);
  }

  // ── Agent ────────────────────────────────────────────────────

  async deployAgent(accountId: string, req: DeployAgentRequest): Promise<Agent> {
    return this.request<Agent>('POST', `/v1/accounts/${accountId}/agents`, req);
  }

  async getAgent(agentId: string): Promise<Agent> {
    return this.request<Agent>('GET', `/v1/agents/${agentId}`);
  }

  async pauseAgent(agentId: string): Promise<Agent> {
    return this.request<Agent>('POST', `/v1/agents/${agentId}/pause`);
  }

  async resumeAgent(agentId: string): Promise<Agent> {
    return this.request<Agent>('POST', `/v1/agents/${agentId}/resume`);
  }

  async stopAgent(agentId: string): Promise<Agent> {
    return this.request<Agent>('POST', `/v1/agents/${agentId}/stop`);
  }

  // ── Swap ─────────────────────────────────────────────────────

  async swap(req: SwapRequest): Promise<SwapReceipt> {
    return this.request<SwapReceipt>('POST', '/v1/swaps', req);
  }

  // ── WebSocket ────────────────────────────────────────────────

  connectWebSocket(): WebSocketHandle {
    const ws = new WebSocket(this.wsUrl);
    const listeners = new Map<WsEvent['type'], Set<(data: WsEvent) => void>>();

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const parsed: WsEvent = JSON.parse(event.data as string);
        const handlers = listeners.get(parsed.type);
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed);
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    return {
      on: (event: WsEvent['type'], handler: (data: WsEvent) => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(handler);
      },
      off: (event: WsEvent['type'], handler: (data: WsEvent) => void) => {
        const handlers = listeners.get(event);
        if (handlers) {
          handlers.delete(handler);
        }
      },
      close: () => {
        ws.close();
      },
    };
  }

  // ── WebSocket with Auto-Reconnect ────────────────────────────

  connectWebSocketReconnecting(config?: ReconnectConfig): WebSocketHandle {
    const maxReconnectAttempts = config?.maxReconnectAttempts ?? 10;
    const reconnectDelay = config?.reconnectDelay ?? 1000;
    const listeners = new Map<WsEvent['type'], Set<(data: WsEvent) => void>>();
    let ws: WebSocket;
    let closed = false;
    let reconnectCount = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(this.wsUrl);

      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          const parsed: WsEvent = JSON.parse(event.data as string);
          const handlers = listeners.get(parsed.type);
          if (handlers) {
            for (const handler of handlers) {
              handler(parsed);
            }
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.addEventListener('open', () => {
        reconnectCount = 0;
      });

      ws.addEventListener('close', () => {
        if (closed) return;
        if (reconnectCount >= maxReconnectAttempts) return;

        const delayMs = jitter(reconnectDelay * Math.pow(2, reconnectCount));
        reconnectCount++;
        reconnectTimer = setTimeout(connect, delayMs);
      });

      ws.addEventListener('error', () => {
        // close event will handle reconnection
      });
    };

    connect();

    return {
      on: (event: WsEvent['type'], handler: (data: WsEvent) => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)!.add(handler);
      },
      off: (event: WsEvent['type'], handler: (data: WsEvent) => void) => {
        const handlers = listeners.get(event);
        if (handlers) {
          handlers.delete(handler);
        }
      },
      close: () => {
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        ws.close();
      },
    };
  }
}

export { AidosApiError };
