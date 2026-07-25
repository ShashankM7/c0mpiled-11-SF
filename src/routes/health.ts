import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => {
    const cfg = getConfig();
    const mode = (enabled: boolean): 'live' | 'fixture' => (enabled ? 'live' : 'fixture');
    return {
      ok: true,
      demo_mode: cfg.demoMode,
      adapters: {
        channel3: mode(cfg.adapters.channel3.enabled),
        crustdata: mode(cfg.adapters.crustdata.enabled),
        voygr: mode(cfg.adapters.voygr.enabled),
        oway: mode(cfg.adapters.oway.enabled),
        callwright: mode(cfg.adapters.callwright.enabled),
        phonely: mode(cfg.adapters.phonely.enabled),
      },
    };
  });
}
