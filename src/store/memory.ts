import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ApprovalChain,
  AuditEntry,
  CallOutcome,
  DestinationCheck,
  FreightQuote,
  LandedCost,
  Org,
  ProcurementRequest,
  ProductOption,
  RunEvent,
  RunRecord,
  Supplier,
  User,
} from '../types.js';
import type { Store } from './index.js';
import { logger } from '../logger.js';

interface State {
  orgs: Org[];
  users: User[];
  requests: ProcurementRequest[];
  options: Record<string, ProductOption[]>;
  suppliers: Record<string, Supplier[]>;
  destinationChecks: Record<string, DestinationCheck>;
  freightQuotes: Record<string, FreightQuote>;
  landedCosts: Record<string, LandedCost>;
  approvalChains: Record<string, ApprovalChain>;
  callOutcomes: Record<string, CallOutcome[]>;
  runs: RunRecord[];
  events: Record<string, RunEvent[]>;
  audit: AuditEntry[];
}

const emptyState = (): State => ({
  orgs: [],
  users: [],
  requests: [],
  options: {},
  suppliers: {},
  destinationChecks: {},
  freightQuotes: {},
  landedCosts: {},
  approvalChains: {},
  callOutcomes: {},
  runs: [],
  events: {},
  audit: [],
});

/**
 * In-memory Store with a JSON snapshot written to disk on every mutation and
 * loaded on boot. Pass snapshotPath = null for a purely ephemeral store
 * (tests, demo).
 */
export class MemoryStore implements Store {
  private state: State;

  constructor(private readonly snapshotPath: string | null = '.data/state.json') {
    this.state = emptyState();
    if (this.snapshotPath !== null && existsSync(this.snapshotPath)) {
      try {
        const raw = readFileSync(this.snapshotPath, 'utf8');
        this.state = { ...emptyState(), ...(JSON.parse(raw) as Partial<State>) };
      } catch (err) {
        logger.warn({ err }, 'failed to load state snapshot; starting empty');
      }
    }
  }

  private persist(): void {
    if (this.snapshotPath === null) return;
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true });
      writeFileSync(this.snapshotPath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.warn({ err }, 'failed to write state snapshot');
    }
  }

  async putOrg(org: Org): Promise<void> {
    this.state.orgs = this.state.orgs.filter((o) => o.id !== org.id).concat(org);
    this.persist();
  }

  async getOrg(id: string): Promise<Org | null> {
    return this.state.orgs.find((o) => o.id === id) ?? null;
  }

  async putUser(user: User): Promise<void> {
    this.state.users = this.state.users.filter((u) => u.id !== user.id).concat(user);
    this.persist();
  }

  async getUserById(id: string): Promise<User | null> {
    return this.state.users.find((u) => u.id === id) ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const needle = email.toLowerCase();
    return this.state.users.find((u) => u.email.toLowerCase() === needle) ?? null;
  }

  async listOrgUsers(orgId: string): Promise<User[]> {
    return this.state.users.filter((u) => u.org_id === orgId);
  }

  async putRequest(request: ProcurementRequest): Promise<void> {
    this.state.requests = this.state.requests
      .filter((r) => r.id !== request.id)
      .concat(structuredClone(request));
    this.persist();
  }

  async getRequest(id: string): Promise<ProcurementRequest | null> {
    const found = this.state.requests.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  async listRequests(orgId: string): Promise<ProcurementRequest[]> {
    return structuredClone(
      this.state.requests
        .filter((r) => r.org_id === orgId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    );
  }

  async putOptions(requestId: string, options: ProductOption[]): Promise<void> {
    this.state.options[requestId] = structuredClone(options);
    this.persist();
  }

  async getOptions(requestId: string): Promise<ProductOption[]> {
    return structuredClone(this.state.options[requestId] ?? []);
  }

  async putSupplier(requestId: string, supplier: Supplier): Promise<void> {
    const list = this.state.suppliers[requestId] ?? [];
    this.state.suppliers[requestId] = list
      .filter((s) => s.id !== supplier.id)
      .concat(structuredClone(supplier));
    this.persist();
  }

  async getSuppliers(requestId: string): Promise<Supplier[]> {
    return structuredClone(this.state.suppliers[requestId] ?? []);
  }

  async putDestinationCheck(check: DestinationCheck): Promise<void> {
    this.state.destinationChecks[check.request_id] = structuredClone(check);
    this.persist();
  }

  async getDestinationCheck(requestId: string): Promise<DestinationCheck | null> {
    const found = this.state.destinationChecks[requestId];
    return found ? structuredClone(found) : null;
  }

  async putFreightQuote(quote: FreightQuote): Promise<void> {
    this.state.freightQuotes[quote.request_id] = structuredClone(quote);
    this.persist();
  }

  async getFreightQuote(requestId: string): Promise<FreightQuote | null> {
    const found = this.state.freightQuotes[requestId];
    return found ? structuredClone(found) : null;
  }

  async putLandedCost(requestId: string, landedCost: LandedCost): Promise<void> {
    this.state.landedCosts[requestId] = structuredClone(landedCost);
    this.persist();
  }

  async getLandedCost(requestId: string): Promise<LandedCost | null> {
    const found = this.state.landedCosts[requestId];
    return found ? structuredClone(found) : null;
  }

  async putApprovalChain(chain: ApprovalChain): Promise<void> {
    this.state.approvalChains[chain.request_id] = structuredClone(chain);
    this.persist();
  }

  async getApprovalChain(requestId: string): Promise<ApprovalChain | null> {
    const found = this.state.approvalChains[requestId];
    return found ? structuredClone(found) : null;
  }

  async putCallOutcome(outcome: CallOutcome): Promise<void> {
    const list = this.state.callOutcomes[outcome.request_id] ?? [];
    this.state.callOutcomes[outcome.request_id] = list.concat(structuredClone(outcome));
    this.persist();
  }

  async listCallOutcomes(requestId: string): Promise<CallOutcome[]> {
    return structuredClone(this.state.callOutcomes[requestId] ?? []);
  }

  async putRun(run: RunRecord): Promise<void> {
    this.state.runs = this.state.runs.filter((r) => r.id !== run.id).concat(structuredClone(run));
    this.persist();
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const found = this.state.runs.find((r) => r.id === id);
    return found ? structuredClone(found) : null;
  }

  async listRunsForRequest(requestId: string): Promise<RunRecord[]> {
    return structuredClone(
      this.state.runs
        .filter((r) => r.request_id === requestId)
        .sort((a, b) => a.started_at.localeCompare(b.started_at)),
    );
  }

  async appendEvent(event: Omit<RunEvent, 'seq'>): Promise<RunEvent> {
    const list = this.state.events[event.run_id] ?? [];
    const full: RunEvent = { ...structuredClone(event), seq: list.length + 1 };
    this.state.events[event.run_id] = list.concat(full);
    this.persist();
    return structuredClone(full);
  }

  async listEvents(runId: string, afterSeq = 0): Promise<RunEvent[]> {
    return structuredClone((this.state.events[runId] ?? []).filter((e) => e.seq > afterSeq));
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.state.audit.push(structuredClone(entry));
    this.persist();
  }

  async listAudit(requestId: string): Promise<AuditEntry[]> {
    return structuredClone(this.state.audit.filter((a) => a.request_id === requestId));
  }
}
