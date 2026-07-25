import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProductOption } from '../types.js';
import { getConfig } from '../config.js';
import { readFixture, step, type StepResult } from './step.js';

export interface SearchProductsInput {
  query: string;
  quantity: number;
}

const RawSchema = z.object({
  products: z.array(
    z.object({
      name: z.string(),
      merchant: z.string(),
      domain: z.string(),
      price_cents: z.number().int(),
      quantity_available: z.number().int().nullable(),
      lead_time_days: z.number().int().nullable(),
      buy_url: z.string(),
      image_url: z.string().nullable(),
    }),
  ),
});

// TODO: verify against vendor docs — this shape is inferred; the fixture is
// the source of truth for the demo and the normalized ProductOption is the
// internal contract.
function mapResponse(raw: unknown, input: SearchProductsInput): ProductOption[] {
  const parsed = RawSchema.parse(raw);
  return parsed.products.map((p) => ({
    id: randomUUID(),
    request_id: '', // assigned by the orchestrator
    title: p.name,
    merchant_name: p.merchant,
    merchant_domain: p.domain,
    unit_price_cents: p.price_cents,
    quantity_available: p.quantity_available,
    lead_time_days: p.lead_time_days,
    buy_url: p.buy_url,
    image_url: p.image_url,
    label: null,
    extended_price_cents: p.price_cents * input.quantity,
  }));
}

/** Real products, prices, availability, merchant, buy link. Returns >= 3 options. */
export async function searchProducts(
  input: SearchProductsInput,
): Promise<StepResult<ProductOption[]>> {
  const cfg = getConfig();
  const adapter = cfg.adapters.channel3;
  let raw: unknown = null;
  return step({
    adapter: 'channel3',
    enabled: adapter.enabled,
    live: async () => {
      const res = await fetch(`${adapter.baseUrl ?? 'https://api.trychannel3.com'}/v0/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': adapter.key ?? '' },
        body: JSON.stringify({ query: input.query, limit: 5 }),
      });
      if (!res.ok) throw new Error(`channel3 responded ${res.status}`);
      raw = await res.json();
      return mapResponse(raw, input);
    },
    fixture: async () => mapResponse(await readFixture('channel3.chairs.json'), input),
    capture: { slug: 'chairs', getRaw: () => raw },
  });
}
