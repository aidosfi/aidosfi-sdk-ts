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
  PaginationParams,
  PaginatedResponse,
  WsEvent,
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

export class AidosClient {
  private apiKey: string;
  private baseUrl: string;
  private wsUrl: string;
  private timeout: number;

  constructor(config: AidosConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.aidosfi.com';
    this.wsUrl = config.wsUrl ?? 'wss://ws.aidosfi.com';
    this.timeout = config.timeout ?? 30_000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

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
        throw new AidosApiError(errorBody);
      }

      if (response.status === 204) {
        return undefined as unknown as T;
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
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
}

export { AidosApiError };
