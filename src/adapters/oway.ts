import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FreightQuote } from '../types.js';
import { getConfig } from '../config.js';
import { readFixture, step, type StepResult } from './step.js';

export interface QuoteFreightInput {
  dest_zip: string;
  pallets: number;
  ready_date: string; // ISO date
}

const RawSchema = z.object({
  quote: z.object({
    mode: z.enum(['LTL_PALLET', 'PARCEL']),
    cost_cents: z.number().int(),
    transit_days: z.number().int(),
    retail_parcel_baseline_cents: z.number().int().nullable(),
  }),
});

function addDaysIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// TODO: verify against vendor docs — shape inferred; fixture is the demo's
// source of truth, FreightQuote is the internal contract.
function mapResponse(raw: unknown, input: QuoteFreightInput): FreightQuote {
  const parsed = RawSchema.parse(raw);
  return {
    id: randomUUID(),
    request_id: '', // assigned by the orchestrator
    mode: parsed.quote.mode,
    pallets: input.pallets,
    destination_zip: input.dest_zip,
    cost_cents: parsed.quote.cost_cents,
    transit_days: parsed.quote.transit_days,
    estimated_delivery: addDaysIsoDate(input.ready_date, parsed.quote.transit_days),
    meets_deadline: false, // computed by the orchestrator against the request deadline
    retail_parcel_baseline_cents: parsed.quote.retail_parcel_baseline_cents,
  };
}

/** LTL pallet quote + transit + estimated delivery + retail-parcel baseline. */
export async function quoteFreight(input: QuoteFreightInput): Promise<StepResult<FreightQuote>> {
  const cfg = getConfig();
  const adapter = cfg.adapters.oway;
  let raw: unknown = null;
  return step({
    adapter: 'oway',
    enabled: adapter.enabled,
    live: async () => {
      const res = await fetch(`${adapter.baseUrl ?? 'https://api.oway.io'}/v1/quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adapter.key ?? ''}` },
        body: JSON.stringify({
          destination_zip: input.dest_zip,
          pallets: input.pallets,
          ready_date: input.ready_date,
        }),
      });
      if (!res.ok) throw new Error(`oway responded ${res.status}`);
      raw = await res.json();
      return mapResponse(raw, input);
    },
    fixture: async () => mapResponse(await readFixture('oway.quote.json'), input),
    capture: { slug: 'quote', getRaw: () => raw },
  });
}
