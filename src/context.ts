import type { Store } from './store/index.js';
import type { EventBus } from './orchestrator/events.js';
import type { Orchestrator } from './orchestrator/run.js';
import type { IdentityProvider } from './adapters/identity.js';

export interface AppCtx {
  store: Store;
  bus: EventBus;
  identity: IdentityProvider;
  orchestrator: Orchestrator;
}
