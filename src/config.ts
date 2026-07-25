import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  DEMO_MODE: z.enum(['auto', 'fixture', 'live']).default('auto'),
  ADAPTER_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  UNITS_PER_PALLET: z.coerce.number().int().positive().default(16),
  CAPTURE: z.enum(['0', '1']).default('0'),
  AUTH_SECRET: z.string().default('procureos-dev-secret'),
  DEMO_CALL_NUMBER: z.string().optional(),
  IDENTITY_PROVIDER: z.enum(['local', 'hexclave']).default('local'),

  CHANNEL3_API_KEY: z.string().optional(),
  CHANNEL3_BASE_URL: z.string().optional(),
  CRUSTDATA_API_KEY: z.string().optional(),
  CRUSTDATA_BASE_URL: z.string().optional(),
  VOYGR_API_KEY: z.string().optional(),
  VOYGR_BASE_URL: z.string().optional(),
  OWAY_API_KEY: z.string().optional(),
  OWAY_BASE_URL: z.string().optional(),
  CALLWRIGHT_API_KEY: z.string().optional(),
  CALLWRIGHT_BASE_URL: z.string().optional(),
  PHONELY_API_KEY: z.string().optional(),
  PHONELY_WEBHOOK_SECRET: z.string().optional(),
  HEXCLAVE_API_KEY: z.string().optional(),
  HEXCLAVE_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type AdapterName =
  | 'channel3' | 'crustdata' | 'voygr' | 'oway' | 'callwright' | 'phonely' | 'hexclave';

export interface AdapterConfig {
  key: string | null;
  baseUrl: string | null;
  /** false when the key is missing or DEMO_MODE=fixture — the live path is never attempted. */
  enabled: boolean;
}

export interface Config {
  port: number;
  demoMode: 'auto' | 'fixture' | 'live';
  adapterTimeoutMs: number;
  unitsPerPallet: number;
  capture: boolean;
  authSecret: string;
  demoCallNumber: string | null;
  identityProvider: 'local' | 'hexclave';
  llm: { anthropicKey: string | null; openaiKey: string | null };
  adapters: Record<AdapterName, AdapterConfig>;
}

/** Treat empty-string env vars as absent (an empty .env line must not count as a key). */
function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(stripEmpty(env));
  const adapter = (key?: string, baseUrl?: string): AdapterConfig => ({
    key: key ?? null,
    baseUrl: baseUrl ?? null,
    enabled: e.DEMO_MODE !== 'fixture' && key !== undefined,
  });
  return {
    port: e.PORT,
    demoMode: e.DEMO_MODE,
    adapterTimeoutMs: e.ADAPTER_TIMEOUT_MS,
    unitsPerPallet: e.UNITS_PER_PALLET,
    capture: e.CAPTURE === '1',
    authSecret: e.AUTH_SECRET,
    demoCallNumber: e.DEMO_CALL_NUMBER ?? null,
    identityProvider: e.IDENTITY_PROVIDER,
    llm: {
      anthropicKey: e.ANTHROPIC_API_KEY ?? null,
      openaiKey: e.OPENAI_API_KEY ?? null,
    },
    adapters: {
      channel3: adapter(e.CHANNEL3_API_KEY, e.CHANNEL3_BASE_URL),
      crustdata: adapter(e.CRUSTDATA_API_KEY, e.CRUSTDATA_BASE_URL),
      voygr: adapter(e.VOYGR_API_KEY, e.VOYGR_BASE_URL),
      oway: adapter(e.OWAY_API_KEY, e.OWAY_BASE_URL),
      callwright: adapter(e.CALLWRIGHT_API_KEY, e.CALLWRIGHT_BASE_URL),
      phonely: adapter(e.PHONELY_API_KEY, undefined),
      hexclave: adapter(e.HEXCLAVE_API_KEY, e.HEXCLAVE_BASE_URL),
    },
  };
}

let current: Config | null = null;

export function getConfig(): Config {
  if (current === null) current = loadConfig();
  return current;
}

export function setConfig(config: Config): void {
  current = config;
}

/** Force the next getConfig() to re-read process.env (tests, demo). */
export function resetConfig(): void {
  current = null;
}

export const PHONELY_WEBHOOK_SECRET = (): string | null =>
  stripEmpty(process.env)['PHONELY_WEBHOOK_SECRET'] ?? null;
