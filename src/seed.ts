import type { Store } from './store/index.js';
import type { Org, User } from './types.js';

export const SEED_ORG: Org = {
  id: 'org_northgate',
  name: 'Northgate Restaurant Group',
};

export const SEED_USERS: User[] = [
  { id: 'usr_dana', org_id: SEED_ORG.id, name: 'Dana Whitfield', email: 'dana@northgate.test', role: 'requester' },
  { id: 'usr_marcus', org_id: SEED_ORG.id, name: 'Marcus Rivera', email: 'marcus@northgate.test', role: 'manager' },
  { id: 'usr_priya', org_id: SEED_ORG.id, name: 'Priya Raman', email: 'priya@northgate.test', role: 'controller' },
  // Alex exists to be denied: ap_clerk can read and prepare, never approve.
  { id: 'usr_alex', org_id: SEED_ORG.id, name: 'Alex Boone', email: 'alex@northgate.test', role: 'ap_clerk' },
];

export async function seed(store: Store): Promise<void> {
  await store.putOrg(SEED_ORG);
  for (const user of SEED_USERS) {
    await store.putUser(user);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const { MemoryStore } = await import('./store/memory.js');
  const store = new MemoryStore();
  await seed(store);
  console.log(`Seeded ${SEED_ORG.name} with ${SEED_USERS.length} users:`);
  for (const u of SEED_USERS) console.log(`  ${u.name.padEnd(16)} ${u.email.padEnd(24)} ${u.role}`);
}
