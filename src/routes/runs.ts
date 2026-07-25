import type { FastifyInstance } from 'fastify';
import type { RunEvent } from '../types.js';
import type { AppCtx } from '../context.js';
import { notFound } from '../errors.js';
import { authenticate } from './auth.js';

const HEARTBEAT_MS = 15_000;

export function registerRunRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/runs/:id', async (req) => {
    await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    const run = await ctx.store.getRun(id);
    if (run === null) throw notFound('run');
    return { run, events: await ctx.store.listEvents(id) };
  });

  /**
   * SSE stream. Supports ?after_seq=N replay for late joiners and emits a
   * heartbeat comment every 15s. Auth via Bearer header or ?token= (EventSource
   * cannot set headers).
   */
  app.get('/api/runs/:id/events', async (req, reply) => {
    await authenticate(ctx, req);
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    const afterSeq = Number.parseInt(String(query['after_seq'] ?? '0'), 10) || 0;
    const run = await ctx.store.getRun(id);
    if (run === null) throw notFound('run');

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    raw.write(`: connected run=${id} after_seq=${afterSeq}\n\n`);

    let lastSent = afterSeq;
    const send = (event: RunEvent): void => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Replay the persisted backlog first, then go live; seq-based dedupe makes
    // the handoff safe.
    for (const event of await ctx.store.listEvents(id, afterSeq)) send(event);
    const unsubscribe = ctx.bus.subscribe(id, send);
    for (const event of await ctx.store.listEvents(id, lastSent)) send(event);

    const heartbeat = setInterval(() => {
      try {
        raw.write(`: heartbeat\n\n`);
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
  });
}
