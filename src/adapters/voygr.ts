import { z } from 'zod';
import type { PlaceInfo } from '../types.js';
import { getConfig } from '../config.js';
import { readFixture, step, type StepResult } from './step.js';

export interface VerifyPlaceInput {
  name?: string;
  address: string;
}

const RawSchema = z.object({
  place: z.object({
    place_id: z.string().nullable(),
    formatted_address: z.string().nullable(),
    status: z.enum(['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY', 'UNKNOWN']),
    phone: z.string().nullable(),
    phone_status: z.enum(['ACTIVE', 'DISCONNECTED', 'UNKNOWN']).default('UNKNOWN'),
    hours_known: z.boolean(),
    last_verified_at: z.string().nullable(),
  }),
});

// TODO: verify against vendor docs — shape inferred; fixture is the demo's
// source of truth, PlaceInfo is the internal contract.
function mapResponse(raw: unknown): PlaceInfo {
  const parsed = RawSchema.parse(raw);
  return {
    place_id: parsed.place.place_id,
    formatted_address: parsed.place.formatted_address,
    business_status: parsed.place.status,
    phone: parsed.place.phone,
    phone_status: parsed.place.phone_status,
    hours_known: parsed.place.hours_known,
    last_verified_at: parsed.place.last_verified_at,
  };
}

function fixtureFile(input: VerifyPlaceInput): string {
  const key = `${input.name ?? ''} ${input.address}`.toLowerCase();
  if (key.includes('bulkchairs')) return 'voygr.supplier-a.json';
  if (key.includes('seatcraft')) return 'voygr.supplier-b.json';
  if (input.name !== undefined) return 'voygr.supplier-b.json';
  return 'voygr.destination.json';
}

/** Business status, phone, hours, last-verified. Used for suppliers AND the destination. */
export async function verifyPlace(input: VerifyPlaceInput): Promise<StepResult<PlaceInfo>> {
  const cfg = getConfig();
  const adapter = cfg.adapters.voygr;
  let raw: unknown = null;
  return step({
    adapter: 'voygr',
    enabled: adapter.enabled,
    live: async () => {
      const res = await fetch(`${adapter.baseUrl ?? 'https://api.voygr.com'}/v1/places/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': adapter.key ?? '' },
        body: JSON.stringify({ name: input.name ?? null, address: input.address }),
      });
      if (!res.ok) throw new Error(`voygr responded ${res.status}`);
      raw = await res.json();
      return mapResponse(raw);
    },
    fixture: async () => mapResponse(await readFixture(fixtureFile(input))),
    capture: {
      slug: (input.name ?? input.address).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
      getRaw: () => raw,
    },
  });
}
