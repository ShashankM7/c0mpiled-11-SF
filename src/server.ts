import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { getConfig, type Config, setConfig } from './config.js';
import { AppError } from './errors.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/index.js';
import { seed } from './seed.js';
import { EventBus } from './orchestrator/events.js';
import { createOrchestrator } from './orchestrator/run.js';
import { createIdentityProvider } from './adapters/identity.js';
import type { AppCtx } from './context.js';
import { IllegalTransitionError } from './domain/stateMachine.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerRequestRoutes } from './routes/requests.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildOptions {
  store?: Store;
  config?: Config;
  logger?: boolean;
}

export async function buildServer(opts: BuildOptions = {}): Promise<FastifyInstance> {
  if (opts.config !== undefined) setConfig(opts.config);
  const config = getConfig();

  const store = opts.store ?? new MemoryStore();
  await seed(store);

  const bus = new EventBus();
  const ctx: AppCtx = {
    store,
    bus,
    identity: createIdentityProvider(config, store),
    orchestrator: createOrchestrator({ store, bus }),
  };

  const app = Fastify({ logger: opts.logger ?? false });

  // A separate frontend connects from another origin: CORS wide open.
  await app.register(cors, { origin: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.code(err.status).send(err.toBody());
      return;
    }
    if (err instanceof ZodError) {
      void reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'invalid request body', details: err.issues },
      });
      return;
    }
    if (err instanceof IllegalTransitionError) {
      void reply.code(409).send({
        error: { code: 'ILLEGAL_TRANSITION', message: err.message, reason: 'ILLEGAL_TRANSITION' },
      });
      return;
    }
    app.log.error(err);
    void reply.code(500).send({
      error: { code: 'INTERNAL', message: 'internal server error' },
    });
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, ctx);
  registerRequestRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerCallRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);

  // Expose ctx for scripts/tests that want direct access (demo, orchestrator tests).
  app.decorate('ctx', ctx);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppCtx;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const app = await buildServer({ logger: true });
  const port = getConfig().port;
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
