# Poly-Gate

A gateway (reverse-proxy + facade) over the Polymarket APIs (**Gamma**, **Data**, **CLOB**), built with **Node.js + TypeScript + Fastify**.

It solves two problems:

1. **Single entry point** for the three Polymarket APIs.
2. **Centralized outbound rate limiting** so all your processes share one budget and don't hit Cloudflare throttling.

It also handles **L2 authentication (POLY_1271, `signatureType: 3`)** on your behalf: wallet keys/creds live in a config file, clients authenticate to the gateway with a single bearer token, and multiple wallets are supported.

## Features

- Routes mirror Polymarket paths/params **1:1** under an `/gamma`, `/clob` or `/data` prefix.
- Bearer auth **only** on private CLOB endpoints (the token also selects the wallet).
- Boots and serves **all public endpoints even with zero wallets configured**.
- Outbound rate limiting (Bottleneck) with one bucket per Polymarket endpoint group.
- Automatic retries (backoff + jitter) on idempotent calls; **`POST /clob/order` is never retried** (duplicate risk).
- Swagger UI at `/docs`.

## Requirements

- Node.js >= 20 (developed on 24)

## Setup

```bash
npm install
cp config.example.yaml config.yaml   # then edit
cp .env.example .env                  # optional
```

Point the gateway at your config via `POLY_GATE_CONFIG` (defaults to `./config.yaml`).

### Getting L2 credentials

```bash
PRIVATE_KEY=0x... npm run derive-creds
```

Copy the printed `apiKey/secret/passphrase` into the matching user's `creds` block.

## Run

```bash
npm run dev      # watch mode (tsx)
npm run build && npm start   # production
```

- Health: `GET /health`
- Swagger UI: `GET /docs`

## Configuration

See [`config.example.yaml`](./config.example.yaml). Key points:

- `users` is **optional**. Without users only public endpoints work.
- Per user: `token` (gateway bearer), `privateKey` (signer/EOA is derived from it), `funder` (Polymarket **proxy wallet**, not derivable), `signatureType: 3`, and `creds`.
- From the config we use **only authorization data** — endpoint params are never auto-injected.

## Endpoints

| Method + path | Upstream | Auth |
| --- | --- | --- |
| `GET /gamma/events/keyset` | Gamma `/events/keyset` | – |
| `GET /gamma/events/slug/{slug}` | Gamma `/events/slug/{slug}` | – |
| `GET /gamma/public-profile` | Gamma `/public-profile` | – |
| `POST /clob/books` | CLOB `/books` (direct, not SDK) | – |
| `POST /clob/order` | CLOB `/order` (signed, no retry) | Bearer |
| `DELETE /clob/order` | CLOB `/order` | Bearer |
| `GET /clob/data/order/{orderID}` | CLOB `/data/order/{orderID}` | Bearer |
| `GET /clob/data/trades` | CLOB `/data/trades` | Bearer |
| `GET /clob/balance-allowance` | CLOB balance/allowance | Bearer |
| `GET /data/closed-positions` | Data `/closed-positions` | – |
| `GET /data/activity` | Data `/activity` | – |
| `GET /data/trades` | Data `/trades` | – |
| `GET /data/accounting/snapshot` | Data `/v1/accounting/snapshot` (ZIP) | – |
| `GET /data/leaderboard` | Data `/v1/leaderboard` | – |
| `GET /data/holders` | Data `/holders` | – |

### Placing an order

`POST /clob/order` takes a high-level body (the gateway signs it):

```json
{
  "tokenID": "123...",
  "side": "BUY",
  "orderType": "GTC",
  "price": 0.65,
  "size": 100,
  "tickSize": "0.01",
  "negRisk": false
}
```

`tickSize` and `negRisk` are required. For `FOK`/`FAK` provide `amount` instead of `size`.

### Balances

- USDC/collateral: `GET /clob/balance-allowance?asset_type=COLLATERAL`
- A token: `GET /clob/balance-allowance?asset_type=CONDITIONAL&token_id=...`

## Testing

```bash
npm test
npm run typecheck
```

## Notes

- Runs as a single instance (in-memory limiter; no horizontal scaling).
- Uses `@polymarket/clob-client-v2` for private CLOB only; public traffic goes directly through `fetch`.
