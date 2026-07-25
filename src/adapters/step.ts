import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { AdapterTelemetry } from '../types.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export async function readFixture(name: string): Promise<unknown> {
  const raw = await readFile(join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as unknown;
}

export interface StepResult<T> {
  data: T;
  telemetry: AdapterTelemetry;
}

export interface StepOptions<T> {
  adapter: string;
  live: () => Promise<T>;
  fixture: () => T | Promise<T>;
  timeoutMs?: number;
  /** false when the key is missing or DEMO_MODE=fixture — live() is never called. */
  enabled: boolean;
  /** With CAPTURE=1 and a successful live call, the raw response is written to fixtures/<adapter>.<slug>.json. */
  capture?: { slug: string; getRaw: () => unknown };
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    t.unref();
  });
}

/**
 * The single wrapper every external call goes through. Hard timeout, fixture
 * fallback, optional capture, telemetry. A hanging or failing vendor API can
 * never stall or fail a run: errors are logged, never propagated.
 */
export async function step<T>(opts: StepOptions<T>): Promise<StepResult<T>> {
  const timeoutMs = opts.timeoutMs ?? getConfig().adapterTimeoutMs;
  const start = performance.now();

  const serveFixture = async (fellBack: boolean, error: string | null): Promise<StepResult<T>> => {
    const data = await opts.fixture();
    return {
      data,
      telemetry: {
        adapter: opts.adapter,
        live: false,
        fell_back: fellBack,
        duration_ms: Math.round(performance.now() - start),
        error,
      },
    };
  };

  if (!opts.enabled) {
    return serveFixture(false, null);
  }

  try {
    const data = await Promise.race([opts.live(), timeoutAfter(timeoutMs)]);
    if (getConfig().capture && opts.capture !== undefined) {
      await captureRaw(opts.adapter, opts.capture.slug, opts.capture.getRaw());
    }
    return {
      data,
      telemetry: {
        adapter: opts.adapter,
        live: true,
        fell_back: false,
        duration_ms: Math.round(performance.now() - start),
        error: null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ adapter: opts.adapter, err: message }, 'live adapter call failed; serving fixture');
    return serveFixture(true, message);
  }
}

async function captureRaw(adapter: string, slug: string, raw: unknown): Promise<void> {
  if (raw === null || raw === undefined) return;
  try {
    await mkdir(FIXTURES_DIR, { recursive: true });
    const file = join(FIXTURES_DIR, `${adapter}.${slug}.json`);
    await writeFile(file, JSON.stringify(raw, null, 2) + '\n');
    logger.info({ adapter, file }, 'captured live response into fixture');
  } catch (err) {
    logger.warn({ adapter, err }, 'failed to capture fixture');
  }
}
