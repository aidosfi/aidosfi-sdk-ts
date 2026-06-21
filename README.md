# AidosFi TypeScript SDK

`@aidosfi/sdk` — the official TypeScript/JavaScript client for the AidosFi API.  
Build shielded accounts, issue ZK-backed debit cards, deploy TEE-autonomous trading agents, and execute darkpool swaps.

```bash
npm install @aidosfi/sdk
```

## Features

| Category       | Feature                                      |
|---------------|----------------------------------------------|
| **Accounts**  | Create, get, and list shielded accounts with ZK-committed balances |
| **Deposits**  | Deposit assets (USDC, USDT, EURC, SOL) with ZK proof receipts |
| **Cards**     | Issue virtual/physical cards, freeze/unfreeze, get card details |
| **Spending**  | Make merchant payments via card with real-time settlement |
| **Agents**    | Deploy, pause, resume, stop autonomous TEE-guarded trading agents with 6 strategies |
| **Swaps**     | Execute darkpool asset swaps with configurable slippage (ZK-settled) |
| **WebSocket** | Real-time feed: balance updates, agent status changes, card swipes, swap fills |
| **Pagination**| Cursor-based pagination for list endpoints |
| **Errors**    | Typed `AidosApiError` with code, status, and details |

### Core Types

- **Assets**: `USDC` | `USDT` | `EURC` | `SOL`
- **Card Types**: `virtual` | `physical`
- **Agent Strategies**: `dca` | `grid` | `yield_maximizer` | `risk_parity` | `momentum` | `mean_reversion`
- **Intervals**: `1h` | `6h` | `12h` | `1d` | `1w` | `1m`
- **WebSocket Events**: `balance_update` | `agent_update` | `card_swipe` | `swap_fill`

## Quickstart

```ts
import { AidosClient, AidosApiError } from '@aidosfi/sdk';

const aidos = new AidosClient({
  apiKey: 'sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // baseUrl: 'https://api.aidosfi.com',     // default
  // wsUrl:   'wss://ws.aidosfi.com',        // default
  // timeout: 30_000,                         // ms, default
});

// ── Accounts ─────────────────────────────────────
const account = await aidos.createAccount({ label: 'My Vault', asset: 'USDC' });
// Account { id: 'acc_xxx', label: 'My Vault', asset: 'USDC',
//           shieldedBalance: '...', createdAt: '2025-...' }

const acct = await aidos.getAccount(account.id);
const page = await aidos.listAccounts({ limit: 10 });

// ── Deposits ─────────────────────────────────────
const receipt = await aidos.deposit(account.id, {
  asset: 'USDC',
  amount: 5_000,
});
// DepositReceipt { txId, zkProof, settledAt, ... }

// ── Cards ────────────────────────────────────────
const card = await aidos.issueCard(account.id, {
  type: 'virtual',
  limit: 2_000,
  label: 'Travel',
});
// Card { id: 'card_xxx', last4: '1234', status: 'active', ... }

const frozen = await aidos.freezeCard(card.id);
const unfrozen = await aidos.unfreezeCard(card.id);

// ── Spend ────────────────────────────────────────
const spendReceipt = await aidos.spend(card.id, {
  merchant: 'Coffee Shop',
  amount: 4.50,
});
// SpendReceipt { txId, merchant, amount, settledAt }

// ── Agents ───────────────────────────────────────
const agent = await aidos.deployAgent(account.id, {
  strategy: 'dca',
  asset: 'SOL',
  amount: 100,
  interval: '1d',
});
// Agent { id: 'agent_xxx', status: 'running', attestationHash: '...' }

await aidos.pauseAgent(agent.id);
await aidos.resumeAgent(agent.id);
await aidos.stopAgent(agent.id);

// ── Swaps ────────────────────────────────────────
const swapReceipt = await aidos.swap({
  from: 'USDC',
  to: 'SOL',
  amount: 500,
  slippage: 50,   // basis points (0.5%)
});
// SwapReceipt { txId, fromAmount, toAmount, price, zkProof }

// ── WebSocket ────────────────────────────────────
const ws = aidos.connectWebSocket();

ws.on('balance_update', (event) => {
  console.log('Balance:', event.shieldedBalance);
});
ws.on('agent_update', (event) => {
  console.log('Agent status:', event.status);
});
ws.on('card_swipe', (event) => {
  console.log('Card swipe:', event.merchant, event.amount);
});
ws.on('swap_fill', (event) => {
  console.log('Swap filled:', event.fromAmount, '→', event.toAmount);
});

// disconnect
ws.close();
```

## Error Handling

```ts
try {
  await aidos.createAccount({ label: '' });
} catch (err) {
  if (err instanceof AidosApiError) {
    console.log(err.code);    // 'VALIDATION_ERROR'
    console.log(err.message); // 'label is required'
    console.log(err.status);  // 400
  }
}
```

## API Reference

### Constructor

```ts
new AidosClient(config: AidosConfig)
```

| Param       | Type     | Required | Default                         |
|------------|----------|----------|----------------------------------|
| `apiKey`   | `string` | Yes      | —                                |
| `baseUrl`  | `string` | No       | `https://api.aidosfi.com`       |
| `wsUrl`    | `string` | No       | `wss://ws.aidosfi.com`          |
| `timeout`  | `number` | No       | `30_000` (ms)                   |

### Account Endpoints

```ts
createAccount(req: CreateAccountRequest): Promise<Account>
getAccount(accountId: string): Promise<Account>
listAccounts(params?: PaginationParams): Promise<PaginatedResponse<Account>>
```

### Deposit

```ts
deposit(accountId: string, req: DepositRequest): Promise<DepositReceipt>
```

### Card Endpoints

```ts
issueCard(accountId: string, req: IssueCardRequest): Promise<Card>
getCard(cardId: string): Promise<Card>
freezeCard(cardId: string): Promise<Card>
unfreezeCard(cardId: string): Promise<Card>
```

### Spend

```ts
spend(cardId: string, req: SpendRequest): Promise<SpendReceipt>
```

### Agent Endpoints

```ts
deployAgent(accountId: string, req: DeployAgentRequest): Promise<Agent>
getAgent(agentId: string): Promise<Agent>
pauseAgent(agentId: string): Promise<Agent>
resumeAgent(agentId: string): Promise<Agent>
stopAgent(agentId: string): Promise<Agent>
```

### Swap

```ts
swap(req: SwapRequest): Promise<SwapReceipt>
```

### WebSocket

```ts
connectWebSocket(): WebSocketHandle
```

`WebSocketHandle` provides `.on()`, `.off()`, and `.close()` for typed event subscriptions.

## Development

```bash
npm install
npm test            # 4 tests — mock HTTP server + type validation
npm run build       # tsc → dist/
```

## License

MIT
