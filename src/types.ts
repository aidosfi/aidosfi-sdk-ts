/**
 * Aidos Fi SDK — Shared API Types
 * Canonical type definitions consumed by all language SDKs.
 * https://aidosfi.com
 */

// ── Core Types ──────────────────────────────────────────────────

export type Asset = 'USDC' | 'USDT' | 'EURC' | 'SOL';

export type CardType = 'virtual' | 'physical';

export type StrategyName =
  | 'dca'
  | 'grid'
  | 'yield_maximizer'
  | 'risk_parity'
  | 'momentum'
  | 'mean_reversion';

export type Interval = '1h' | '6h' | '12h' | '1d' | '1w' | '1m';

// ── Request / Response Shapes ───────────────────────────────────

export interface CreateAccountRequest {
  label: string;
  asset?: Asset;       // default: 'USDC'
}

export interface Account {
  id: string;
  label: string;
  asset: Asset;
  shieldedBalance: string;  // ZK-committed, no plaintext visible
  createdAt: string;        // ISO 8601
}

export interface DepositRequest {
  asset: Asset;
  amount: number;       // e.g. 5000.00
  source?: string;      // optional IBAN / wallet ref
}

export interface DepositReceipt {
  txId: string;
  asset: Asset;
  amount: number;
  zkProof: string;      // ZK proof of deposit
  settledAt: string;
}

export interface IssueCardRequest {
  type: CardType;
  limit: number;        // spend limit in USDC
  label?: string;
}

export interface Card {
  id: string;
  type: CardType;
  last4: string;
  limit: number;
  spent: number;
  status: 'active' | 'frozen' | 'closed';
  issuedAt: string;
}

export interface SpendRequest {
  merchant: string;
  amount: number;
  currency?: string;    // default: 'USD'
}

export interface SpendReceipt {
  txId: string;
  merchant: string;
  amount: number;
  currency: string;
  cardId: string;
  settledAt: string;
}

export interface DeployAgentRequest {
  strategy: StrategyName;
  asset: Asset;
  amount: number;
  interval: Interval;
  config?: Record<string, unknown>;  // strategy-specific overrides
}

export interface Agent {
  id: string;
  strategy: StrategyName;
  asset: Asset;
  amount: number;
  interval: Interval;
  status: 'running' | 'paused' | 'stopped';
  attestationHash: string;    // TEE remote attestation
  deployedAt: string;
}

export interface SwapRequest {
  from: Asset;
  to: Asset;
  amount: number;
  slippage?: number;    // basis points, default: 50 (0.5%)
}

export interface SwapReceipt {
  txId: string;
  from: Asset;
  to: Asset;
  fromAmount: number;
  toAmount: number;
  price: number;
  zkProof: string;
  settledAt: string;
}

// ── Pagination ──────────────────────────────────────────────────

export interface PaginationParams {
  limit?: number;   // default: 20, max: 100
  cursor?: string;  // for cursor-based pagination
}

export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null;
  hasMore: boolean;
}

// ── WebSocket Events ────────────────────────────────────────────

export type WsEvent =
  | { type: 'balance_update'; accountId: string; shieldedBalance: string }
  | { type: 'agent_update'; agentId: string; status: string }
  | { type: 'card_swipe'; cardId: string; merchant: string; amount: number }
  | { type: 'swap_fill'; txId: string; fromAmount: number; toAmount: number };

// ── Error ───────────────────────────────────────────────────────

export interface AidosError {
  code: string;
  message: string;
  status: number;
  details?: unknown;
}

// ── Client Config ───────────────────────────────────────────────

export interface AidosConfig {
  apiKey: string;
  baseUrl?: string;     // default: https://api.aidosfi.com
  wsUrl?: string;       // default: wss://ws.aidosfi.com
  timeout?: number;     // ms, default: 30_000
}
