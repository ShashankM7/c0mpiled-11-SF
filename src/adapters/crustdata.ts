import { z } from 'zod';
import type { Supplier } from '../types.js';
import { getConfig } from '../config.js';
import { readFixture, step, type StepResult } from './step.js';

export interface EnrichCompanyInput {
  name: string;
  domain: string;
}

const RawSchema = z.object({
  company: z.object({
    legal_name: z.string().nullable(),
    employee_count: z.number().int().nullable(),
    founded_year: z.number().int().nullable(),
    latest_signal: z.string().nullable(),
  }),
});

// TODO: verify against vendor docs — shape inferred; fixture is the demo's
// source of truth, Supplier['identity'] is the internal contract.
function mapResponse(raw: unknown): Supplier['identity'] {
  const parsed = RawSchema.parse(raw);
  return {
    legal_name: parsed.company.legal_name,
    employee_count: parsed.company.employee_count,
    founded_year: parsed.company.founded_year,
    last_activity_signal: parsed.company.latest_signal,
  };
}

function fixtureFile(input: EnrichCompanyInput): string {
  const key = `${input.name} ${input.domain}`.toLowerCase();
  return key.includes('bulkchairs') ? 'crustdata.supplier-a.json' : 'crustdata.supplier-b.json';
}

/** Company identity + latest activity signal. */
export async function enrichCompany(
  input: EnrichCompanyInput,
): Promise<StepResult<Supplier['identity']>> {
  const cfg = getConfig();
  const adapter = cfg.adapters.crustdata;
  let raw: unknown = null;
  return step({
    adapter: 'crustdata',
    enabled: adapter.enabled,
    live: async () => {
      const res = await fetch(
        `${adapter.baseUrl ?? 'https://api.crustdata.com'}/screener/company?domain=${encodeURIComponent(input.domain)}`,
        { headers: { authorization: `Token ${adapter.key ?? ''}` } },
      );
      if (!res.ok) throw new Error(`crustdata responded ${res.status}`);
      raw = await res.json();
      return mapResponse(raw);
    },
    fixture: async () => mapResponse(await readFixture(fixtureFile(input))),
    capture: { slug: input.domain.replace(/[^a-z0-9-]/gi, '-'), getRaw: () => raw },
  });
}
