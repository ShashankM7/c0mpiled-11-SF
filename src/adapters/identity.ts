import { z } from 'zod';
import type { Role, User } from '../types.js';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';
import { logger } from '../logger.js';

/**
 * Identity boundary. Route code only ever sees this interface, so the real
 * provider (Hexclave) can be dropped in via IDENTITY_PROVIDER=hexclave
 * without touching any route.
 */
export interface IdentityProvider {
  authenticate(email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  listOrgUsers(orgId: string): Promise<User[]>;
}

export class LocalIdentityProvider implements IdentityProvider {
  constructor(private readonly store: Store) {}

  authenticate(email: string): Promise<User | null> {
    return this.store.getUserByEmail(email);
  }

  getUser(id: string): Promise<User | null> {
    return this.store.getUserById(id);
  }

  listOrgUsers(orgId: string): Promise<User[]> {
    return this.store.listOrgUsers(orgId);
  }
}

const HexclaveUserSchema = z.object({
  user: z.object({
    id: z.string(),
    org_id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.enum(['requester', 'manager', 'controller', 'ap_clerk']),
  }),
});

// TODO: verify against vendor docs — Hexclave response shape inferred; the
// normalized User type is the contract.
function mapResponse(raw: unknown): User {
  const parsed = HexclaveUserSchema.parse(raw);
  return {
    id: parsed.user.id,
    org_id: parsed.user.org_id,
    name: parsed.user.name,
    email: parsed.user.email,
    role: parsed.user.role as Role,
  };
}

/**
 * HEXCLAVE_* adapter behind the same interface. Any live failure falls back
 * to the local (seeded) provider so identity can never take the server down.
 */
export class HexclaveIdentityProvider implements IdentityProvider {
  private readonly local: LocalIdentityProvider;

  constructor(
    private readonly config: Config,
    store: Store,
  ) {
    this.local = new LocalIdentityProvider(store);
  }

  private async hexclaveFetch(path: string): Promise<User | null> {
    const { key, baseUrl, enabled } = this.config.adapters.hexclave;
    if (!enabled) return null;
    const res = await fetch(`${baseUrl ?? 'https://api.hexclave.com'}${path}`, {
      headers: { authorization: `Bearer ${key ?? ''}` },
    });
    if (!res.ok) throw new Error(`hexclave responded ${res.status}`);
    return mapResponse(await res.json());
  }

  async authenticate(email: string): Promise<User | null> {
    try {
      const user = await this.hexclaveFetch(`/v1/users/by-email/${encodeURIComponent(email)}`);
      if (user !== null) return user;
    } catch (err) {
      logger.warn({ err }, 'hexclave authenticate failed; falling back to local');
    }
    return this.local.authenticate(email);
  }

  async getUser(id: string): Promise<User | null> {
    try {
      const user = await this.hexclaveFetch(`/v1/users/${encodeURIComponent(id)}`);
      if (user !== null) return user;
    } catch (err) {
      logger.warn({ err }, 'hexclave getUser failed; falling back to local');
    }
    return this.local.getUser(id);
  }

  async listOrgUsers(orgId: string): Promise<User[]> {
    // TODO: verify against vendor docs — list endpoint unknown; local roster serves.
    return this.local.listOrgUsers(orgId);
  }
}

export function createIdentityProvider(config: Config, store: Store): IdentityProvider {
  return config.identityProvider === 'hexclave'
    ? new HexclaveIdentityProvider(config, store)
    : new LocalIdentityProvider(store);
}
