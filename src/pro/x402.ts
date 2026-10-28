import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * x402 pay-per-call for the public API (x402 v1, "exact" scheme). A request
 * without payment gets HTTP 402 with the payment requirements; a client that
 * signs a USDC authorization retries with an `X-PAYMENT` header, which Radar
 * verifies and settles through an x402 facilitator before answering.
 *
 * The network must be one the facilitator supports; Elysium is not supported
 * by public facilitators yet, so the defaults point at Base Sepolia USDC.
 */
export interface X402Config {
  facilitatorUrl: string;
  /** x402 network id, e.g. "base-sepolia" or "base" */
  network: string;
  /** USDC contract on that network */
  asset: string;
  /** EIP-712 domain of the asset (USDC: name "USDC", version "2") */
  assetName: string;
  assetVersion: string;
  payTo: string;
  /** price per call in the asset's base units (USDC: 6 decimals, so 1000 = $0.001) */
  priceAtomic: string;
}

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

export function requirements(cfg: X402Config, resource: string, description: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: cfg.network,
    maxAmountRequired: cfg.priceAtomic,
    resource,
    description,
    mimeType: 'application/json',
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    asset: cfg.asset,
    extra: { name: cfg.assetName, version: cfg.assetVersion },
  };
}

function reject(res: ServerResponse, reqs: PaymentRequirements, error: string): false {
  res.writeHead(402, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ x402Version: 1, error, accepts: [reqs] }));
  return false;
}

async function facilitator(cfg: X402Config, path: 'verify' | 'settle', body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${cfg.facilitatorUrl.replace(/\/$/, '')}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return (await res.json().catch(() => ({ error: `facilitator ${path} HTTP ${res.status}` }))) as Record<string, unknown>;
}

/**
 * Returns true when the request carries a valid, settled payment (and sets
 * X-PAYMENT-RESPONSE); otherwise answers 402 itself and returns false.
 */
export async function chargeX402(req: IncomingMessage, res: ServerResponse, cfg: X402Config, resource: string, description: string): Promise<boolean> {
  const reqs = requirements(cfg, resource, description);
  const header = req.headers['x-payment'];
  if (typeof header !== 'string' || !header) return reject(res, reqs, 'X-PAYMENT header is required');

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return reject(res, reqs, 'X-PAYMENT is not base64 JSON');
  }
  const body = { x402Version: 1, paymentPayload, paymentRequirements: reqs };
  try {
    const verified = await facilitator(cfg, 'verify', body);
    if (verified.isValid !== true) return reject(res, reqs, String(verified.invalidReason ?? verified.error ?? 'payment invalid'));
    const settled = await facilitator(cfg, 'settle', body);
    if (settled.success !== true) return reject(res, reqs, String(settled.errorReason ?? settled.error ?? 'settlement failed'));
    res.setHeader('x-payment-response', Buffer.from(JSON.stringify(settled)).toString('base64'));
    return true;
  } catch (err) {
    return reject(res, reqs, `facilitator unavailable: ${(err as Error).message}`);
  }
}
