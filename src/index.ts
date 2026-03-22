import { config } from "dotenv";
config({ path: ".env.local" });

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createWalletClient, http, publicActions } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { Network } from "@x402/core/types";

// ── Environment ───────────────────────────────────────────────────────────────

const envSchema = z.object({
  EVM_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key"),
  EVM_RPC_URL: z
    .string()
    .url("must be a valid URL")
    .default("https://eth.llamarpc.com"),
  EVM_RPC_URL_SEPOLIA: z
    .string()
    .url("must be a valid URL")
    .default("https://rpc.sepolia.org"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4022),
  ALLOWED_ORIGINS: z.string().default("*"),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid environment variables:");
    for (const [field, issues] of Object.entries(result.error.flatten().fieldErrors)) {
      console.error(`   ${field}: ${(issues as string[]).join(", ")}`);
    }
    process.exit(1);
  }
  return result.data;
}

const env = loadEnv();

// ── Viem clients ──────────────────────────────────────────────────────────────

const account = privateKeyToAccount(env.EVM_PRIVATE_KEY as `0x${string}`);

function makeEvmSigner(chain: typeof mainnet | typeof sepolia, rpcUrl: string) {
  const client = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  }).extend(publicActions);

  return toFacilitatorEvmSigner({
    address: account.address,
    readContract:              (args) => client.readContract(args as never),
    verifyTypedData:           (args) => client.verifyTypedData(args as never),
    writeContract:             (args) => client.writeContract(args as never),
    sendTransaction:           (args) => client.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
    getCode:                   (args) => client.getCode(args),
  });
}

// ── x402 facilitator ──────────────────────────────────────────────────────────

const facilitator = new x402Facilitator();

registerExactEvmScheme(facilitator, {
  signer: makeEvmSigner(mainnet, env.EVM_RPC_URL),
  networks: "eip155:1" as Network,
});

registerExactEvmScheme(facilitator, {
  signer: makeEvmSigner(sepolia, env.EVM_RPC_URL_SEPOLIA),
  networks: "eip155:11155111" as Network,
});

// Logging hooks
facilitator.onAfterVerify(async (ctx) => {
  const { result } = ctx;
  console.log(`[verify] ${result.isValid ? "✅ valid" : "❌ invalid"} payer=${result.payer ?? "—"}`);
});

facilitator.onAfterSettle(async (ctx) => {
  const { result } = ctx;
  if (result.success) {
    console.log(`[settle] ✅ tx=${result.transaction} payer=${result.payer ?? "—"}`);
  } else {
    console.log(`[settle] ❌ reason=${result.errorReason ?? "unknown"}`);
  }
});

// ── Hono app ──────────────────────────────────────────────────────────────────

const app = new Hono();

app.use(logger());
app.use(
  cors({
    origin: env.ALLOWED_ORIGINS === "*" ? "*" : env.ALLOWED_ORIGINS.split(","),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

const bodySchema = z.object({
  paymentPayload:      z.record(z.unknown()),
  paymentRequirements: z.record(z.unknown()),
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    signer: account.address,
    networks: ["eip155:1", "eip155:11155111"],
  })
);

app.get("/supported", (c) => c.json(facilitator.getSupported()));

app.post("/verify", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ isValid: false, invalidReason: "invalid_request" }, 400);
  }
  try {
    const response = await facilitator.verify(
      parsed.data.paymentPayload as never,
      parsed.data.paymentRequirements as never,
    );
    return c.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[verify] error:", msg);
    return c.json({ isValid: false, invalidReason: "internal_error", invalidMessage: msg }, 500);
  }
});

app.post("/settle", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ success: false, errorReason: "invalid_request" }, 400);
  }
  try {
    const response = await facilitator.settle(
      parsed.data.paymentPayload as never,
      parsed.data.paymentRequirements as never,
    );
    return c.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[settle] error:", msg);
    return c.json({ success: false, errorReason: "internal_error", errorMessage: msg }, 500);
  }
});

app.notFound((c) => c.json({ error: "not found" }, 404));

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(`🚀 webai3-facilitator`);
console.log(`   Networks : eip155:1 (mainnet), eip155:11155111 (sepolia)`);
console.log(`   Signer   : ${account.address}`);
console.log(`   RPC      : ${env.EVM_RPC_URL}`);
console.log(`   RPC Sep  : ${env.EVM_RPC_URL_SEPOLIA}`);
console.log(`   Port     : ${env.PORT}`);

serve({ fetch: app.fetch, port: env.PORT });
