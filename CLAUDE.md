# CLAUDE.md — webai3-facilitator

x402 payment facilitator for WEBAI3. Settles USDC payments on **Ethereum mainnet** (eip155:1) via EIP-3009 `transferWithAuthorization`. Built with the official `@x402/core` + `@x402/evm` SDK and served over Hono.

---

## What it does

Acts as the trusted third party in the x402 payment flow:

1. **`POST /verify`** — validates that a client's EIP-3009 payment signature is well-formed and the payer has sufficient USDC balance. Does NOT execute on-chain.
2. **`POST /settle`** — executes `transferWithAuthorization` on the USDC contract, moving funds from payer to the resource server's receiver address. Returns the tx hash.
3. **`GET /supported`** — advertises supported networks and schemes.
4. **`GET /health`** — liveness check; returns signer address and network.

---

## Stack

| Layer | Tech |
|---|---|
| HTTP server | Hono + @hono/node-server |
| x402 protocol | @x402/core ^2.7.0, @x402/evm ^2.7.0 |
| EVM client | viem ^2.21.0 |
| Runtime | Node.js 20+ |
| Language | TypeScript (ESM) |

---

## Architecture

```
Request                     webai3-facilitator
  │                              │
  ├─ POST /verify ──────────────►│
  │                              ├─ ExactEvmScheme.verify()
  │                              │    ├─ recover EIP-712 signer from signature
  │                              │    ├─ check USDC balance via readContract
  │                              │    └─ validate time window + payTo address
  │◄── { isValid, payer } ───────┤
  │                              │
  ├─ POST /settle ──────────────►│
  │                              ├─ ExactEvmScheme.settle()
  │                              │    ├─ re-verify signature
  │                              │    ├─ writeContract: USDC.transferWithAuthorization(...)
  │                              │    └─ waitForTransactionReceipt
  │◄── { success, tx, payer } ───┤
```

---

## Operational requirements

- **Hot wallet ETH**: The `EVM_PRIVATE_KEY` account must hold enough ETH to pay Ethereum gas for each settlement. Typical cost: ~50,000–80,000 gas × current gas price. Monitor balance.
- **RPC endpoint**: Use a reliable paid RPC in production (Infura, Alchemy, QuickNode). The default `eth.llamarpc.com` is rate-limited.
- **Secret management**: `EVM_PRIVATE_KEY` is the most sensitive value. Use environment secrets in deployment (Railway, Fly.io, Vercel env vars — never commit `.env`).

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | **Yes** | — | `0x`-prefixed hex private key for the settlement hot wallet |
| `EVM_RPC_URL` | No | `https://eth.llamarpc.com` | Ethereum mainnet RPC URL |
| `PORT` | No | `4022` | HTTP listen port |
| `ALLOWED_ORIGINS` | No | `*` | CORS allowed origins (comma-separated or `*`) |

---

## Commands

```bash
pnpm install          # install dependencies
pnpm dev              # run with hot reload (tsx watch)
pnpm build            # compile to dist/
pnpm start            # run compiled output
pnpm typecheck        # type-check without emitting
```

---

## Connecting webai3_web

Set in `webai3_web/.env.local`:
```
X402_FACILITATOR_URL=http://localhost:4022   # dev
X402_FACILITATOR_URL=https://facilitator.yourdomain.com  # prod
```

The facilitator is called server-to-server from `webai3_web/src/lib/x402.ts` at `/verify` and `/settle`.

---

## Deployment

The facilitator is a standard Node.js HTTP server. It has no database. Recommended options:

| Platform | Notes |
|---|---|
| Railway | One-click Node deploy; set env vars in dashboard |
| Fly.io | Dockerfile optional; `fly launch` auto-detects Node |
| VPS (Ubuntu) | Run with `pm2` or `systemd`; reverse-proxy with Caddy/nginx |

For Fly.io, expose port 4022 (or set `PORT` to `8080` which Fly expects by default).

---

## What NOT to do

- Do not expose `EVM_PRIVATE_KEY` in logs, responses, or source code.
- Do not add a database — the facilitator is intentionally stateless.
- Do not add auth middleware — the facilitator must be publicly reachable by x402 clients. Rate-limit at the infrastructure layer (Cloudflare, nginx) instead.
- Do not change the network from `eip155:1` without also updating `webai3_web/src/lib/x402.ts`.
