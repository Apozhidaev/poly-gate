# Poly-Gate

A gateway (reverse-proxy + facade) over the Polymarket APIs (**Gamma**, **Data**, **CLOB**), built with **Node.js + TypeScript + Fastify**.

It solves two problems:

1. **Single entry point** for the three Polymarket APIs.
2. **Centralized outbound rate limiting** so all your processes share one budget and don't hit Cloudflare throttling.

It also handles **L2 authentication** on your behalf via `@polymarket/client` (`createSecureClient`): wallet keys live in a config file, the SDK derives CLOB credentials at boot, clients authenticate to the gateway with a single bearer token, and multiple wallets are supported.

## Features

- Routes mirror Polymarket paths/params **1:1** under an `/gamma`, `/clob` or `/data` prefix.
- Bearer auth **only** on private CLOB endpoints (the token also selects the wallet).
- Boots and serves **all public endpoints even with zero wallets configured**.
- Outbound rate limiting (Bottleneck) with one bucket per Polymarket endpoint group.
- Automatic retries (backoff + jitter) on idempotent calls; optional **per-API retry overrides** via `profiles`; **`POST /clob/order` is never retried** (duplicate risk).
- Swagger UI at `/docs`.

## Requirements

- Node.js >= 26 (native Temporal API; developed on 26)

## Setup

```bash
npm install
cp config.example.yaml config.yaml   # then edit
cp users.example.yaml users.yaml     # optional — wallet credentials
cp .env.example .env                  # optional — POLY_GATE_CONFIG / POLY_GATE_USERS
```

`.env` is loaded automatically at startup (when the file exists). Config paths may be absolute or relative to the process working directory. Existing shell env vars take precedence.

Point the gateway at your config via `POLY_GATE_CONFIG` (defaults to `./config.yaml`). Wallet credentials load from `POLY_GATE_USERS` when set; leave it unset for public-only mode.

### Generating a seed phrase

```bash
curl -s -X POST http://localhost:8080/system/generate-seed \
  -H 'content-type: application/json' \
  -d '{}'
```

Optional body field: `strength` — `128` (12 words, default) or `256` (24 words). Do not log responses (they contain a seed phrase).

### Getting wallet from seed phrase

```bash
curl -s -X POST http://localhost:8080/system/derive-wallet \
  -H 'content-type: application/json' \
  -d '{"mnemonic":"word1 word2 ... word12"}'
```

Optional body fields: `accountIndex` (default `0`), `addressIndex` (default `0`), `passphrase`. Path: `m/44'/60'/{accountIndex}'/0/{addressIndex}` (MetaMask-style). Do not log request bodies (they contain a seed phrase).

## Run

```bash
npm run dev      # watch mode (tsx)
npm run build && npm start   # production
```

- Health: `GET /system/health`
- L2 credentials (Bearer): `GET /system/user-creds`
- Swagger UI: `GET /docs`

## Configuration

Two YAML files:

- [`config.example.yaml`](./config.example.yaml) — server, upstreams, rate limits, retries, logging.
- [`users.example.yaml`](./users.example.yaml) — wallet credentials (secrets); copy to `users.yaml` and set `POLY_GATE_USERS=./users.yaml`.

Key points:

- **`POLY_GATE_USERS` unset** → no wallets loaded; only public endpoints work.
- Per user in `users.yaml`: `token` (gateway bearer), `privateKey` (signer/EOA is derived from it), `funder` (Polymarket **deposit / proxy wallet**, passed as SDK `wallet`).
- L2 API credentials are derived by `@polymarket/client` at boot — not stored in config.
- From the config we use **only authorization data** — endpoint params are never auto-injected.
- **Retries:** global `retries.*` applies to all APIs; override `maxElapsedMs` / `attempts` per API via `profiles.<api>.retries`. `http.timeoutMs` is shared across all APIs.

## Endpoints

| Method + path | Upstream | Auth |
| --- | --- | --- |
| `GET /gamma/events` | Gamma `/events/keyset` | – |
| `POST /gamma/events` | Gamma `GET /events/keyset` + `toPostEvent` | – |
| `GET /gamma/markets` | Gamma `/markets/keyset` | – |
| `GET /gamma/events/slug/{slug}` | Gamma `/events/slug/{slug}` | – |
| `POST /gamma/events/slug/{slug}` | Gamma `GET /events/slug/{slug}` + `toPostEvent` | – |
| `GET /gamma/markets/slug/{slug}` | Gamma `/markets/slug/{slug}` | – |
| `GET /gamma/series/{id}` | Gamma `/series/{id}` | – |
| `GET /gamma/public-profile` | Gamma `/public-profile` | – |
| `GET /clob/order-book` | CLOB `/book` (`token_id`) | – |
| `GET /clob/markets/{condition_id}` | CLOB `/markets/{condition_id}` | – |
| `POST /clob/order-books` | CLOB `/books` (direct, not SDK) | – |
| `POST /clob/order` | CLOB `/order` (signed, no retry) | Bearer |
| `DELETE /clob/order` | CLOB `/order` | Bearer |
| `GET /clob/order/{orderID}` | CLOB `/data/order/{orderID}` | Bearer |
| `GET /clob/user-trades` | CLOB `/data/trades` | Bearer |
| `GET /clob/usdc-balance` | CLOB USDC/collateral balance | Bearer |
| `GET /clob/token-balance` | CLOB conditional token balance (`token_id`) | Bearer |
| `GET /data/positions` | Data `/positions` | – |
| `GET /data/closed-positions` | Data `/closed-positions` | – |
| `GET /data/activity` | Data `/activity` | – |
| `GET /data/trades` | Data `/trades` | – |
| `GET /data/accounting/snapshot` | Data `/v1/accounting/snapshot` (equity as JSON) | – |
| `GET /data/leaderboard` | Data `/v1/leaderboard` | – |
| `GET /data/holders` | Data `/holders` | – |
| `GET /pnl/user-pnl` | user-pnl-api `/user-pnl` | – |
| `GET /system/health` | – (gateway meta) | – |
| `POST /system/generate-seed` | – (local BIP39 generation) | – |
| `POST /system/derive-wallet` | – (local BIP39 derivation) | – |
| `GET /system/user-creds` | SecureClient `credentials` | Bearer |

### Placing an order

`POST /clob/order` takes a high-level body (the gateway signs it):

```json
{
  "tokenID": "123...",
  "side": "BUY",
  "orderType": "GTC",
  "price": 0.65,
  "size": 100
}
```

Tick size and neg-risk are resolved by the SDK. For `FOK`/`FAK` provide `amount` instead of `size`.
### Balances

- USDC/collateral: `GET /clob/usdc-balance`
- A token: `GET /clob/token-balance?token_id=...`

Both return `{ "balance": <number> }` in human-readable units (6 decimals).

### Accounting snapshot

`GET /data/accounting/snapshot?user=0x...` downloads the upstream ZIP, extracts `equity.csv` and returns it as a JSON object:

```json
{
  "cashBalance": 9742.99879,
  "positionsValue": 63635.61211,
  "equity": 73378.6109,
  "valuationTime": "2026-06-18T02:19:40Z"
}
```

## Testing

```bash
npm test
npm run typecheck
```

## Notes

- Runs as a single instance (in-memory limiter; no horizontal scaling).
- Uses `@polymarket/client` (`createSecureClient`) for private CLOB only; public traffic goes directly through `fetch`.
