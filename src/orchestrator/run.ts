import { randomUUID } from 'node:crypto';
import type {
  AdapterTelemetry,
  DestinationCheck,
  PlaceRecord,
  PlaceInfo,
  ProcurementRequest,
  ProductOption,
  RequestState,
  RunEventType,
  RunRecord,
  Supplier,
} from '../types.js';
import type { Store } from '../store/index.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { assertTransition } from '../domain/stateMachine.js';
import { evaluateDestination, evaluateSupplier } from '../domain/verification.js';
import { computeLandedCost } from '../domain/landedCost.js';
import { requiredApproval } from '../domain/policy.js';
import { searchProducts } from '../adapters/channel3.js';
import { enrichCompany } from '../adapters/crustdata.js';
import { verifyPlace } from '../adapters/voygr.js';
import { quoteFreight } from '../adapters/oway.js';
import { parseRequest } from './parse.js';
import type { EventBus } from './events.js';

export interface Orchestrator {
  /** Kick off the pipeline; resolves with the run id, execution continues async. */
  startRun(requestId: string, actorUserId: string, now?: string): Promise<string>;
  /** Await a run started in this process (tests, demo). */
  waitForRun(runId: string): Promise<void>;
}

interface Deps {
  store: Store;
  bus: EventBus;
}

/** Strip the internal phone_status so stored records match the §5 contract exactly. */
function toPlaceRecord(info: PlaceInfo): PlaceRecord {
  const { phone_status: _phone_status, ...place } = info;
  return place;
}

export function createOrchestrator(deps: Deps): Orchestrator {
  const { store, bus } = deps;
  const active = new Map<string, Promise<void>>();

  async function startRun(requestId: string, actorUserId: string, now?: string): Promise<string> {
    const runId = `run_${randomUUID()}`;
    const run: RunRecord = {
      id: runId,
      request_id: requestId,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    await store.putRun(run);
    const promise = executeRun(runId, requestId, actorUserId, now ?? new Date().toISOString())
      .catch((err) => {
        logger.error({ err, runId }, 'run crashed outside its own error handling');
      })
      .finally(() => {
        active.delete(runId);
      });
    active.set(runId, promise);
    return runId;
  }

  async function waitForRun(runId: string): Promise<void> {
    await (active.get(runId) ?? Promise.resolve());
  }

  async function executeRun(
    runId: string,
    requestId: string,
    actorUserId: string,
    now: string,
  ): Promise<void> {
    const emit = async (
      type: RunEventType,
      payload: unknown,
      telemetry: AdapterTelemetry | null = null,
    ): Promise<void> => {
      const event = await store.appendEvent({
        run_id: runId,
        request_id: requestId,
        type,
        at: new Date().toISOString(),
        payload,
        telemetry,
      });
      bus.publish(event);
    };

    const setState = async (
      request: ProcurementRequest,
      to: RequestState,
      cause: string,
    ): Promise<void> => {
      assertTransition(request.state, to);
      const from = request.state;
      request.state = to;
      request.updated_at = new Date().toISOString();
      await store.putRequest(request);
      await store.appendAudit({
        request_id: requestId,
        from,
        to,
        cause,
        actor: actorUserId,
        at: new Date().toISOString(),
      });
      await emit('state.changed', { from, to, cause });
    };

    const finishRun = async (status: RunRecord['status']): Promise<void> => {
      const run = await store.getRun(runId);
      if (run === null) return;
      run.status = status;
      run.finished_at = new Date().toISOString();
      await store.putRun(run);
    };

    const request = await store.getRequest(requestId);
    if (request === null) {
      await emit('run.failed', { reason: 'request not found' });
      await finishRun('FAILED');
      return;
    }

    try {
      await emit('run.started', { request_id: requestId, actor: actorUserId, now });

      // 1. Parse ------------------------------------------------------------
      const parsed = await parseRequest(request.raw_text, now);
      // Explicit values supplied at creation win over parsed values.
      request.item_description = request.item_description ?? parsed.item_description;
      request.quantity = request.quantity ?? parsed.quantity;
      request.deadline = request.deadline ?? parsed.deadline;
      request.delivery_address = request.delivery_address ?? parsed.delivery_address;
      request.budget_max_cents = request.budget_max_cents ?? parsed.budget_max_cents;
      await store.putRequest(request);
      await emit('request.parsed', { parsed });
      await setState(request, 'PARSED', 'request parsed into structured constraints');

      const quantity = request.quantity ?? 1;

      // 2. Source -----------------------------------------------------------
      await setState(request, 'SOURCING', 'product sourcing started');
      await emit('sourcing.started', { query: request.item_description, quantity });
      const search = await searchProducts({
        query: request.item_description ?? request.raw_text,
        quantity,
      });
      const options: ProductOption[] = search.data.map((o) => ({ ...o, request_id: requestId }));

      // Initial labels; BEST_LANDED_VALUE is assigned only after freight is known.
      const byPrice = [...options].sort((a, b) => a.extended_price_cents - b.extended_price_cents);
      const lowest = byPrice[0];
      if (lowest !== undefined) lowest.label = 'LOWEST_PRICE';
      const fastest = [...options]
        .filter((o) => o.lead_time_days !== null)
        .sort((a, b) => (a.lead_time_days as number) - (b.lead_time_days as number))[0];
      if (fastest !== undefined && fastest.id !== lowest?.id) fastest.label = 'FASTEST';

      await store.putOptions(requestId, options);
      await emit('sourcing.completed', { options }, search.telemetry);
      await setState(request, 'SOURCED', `${options.length} product options sourced`);

      // 3. Verify suppliers, cheapest first. Rejection loops back to SOURCED. -
      await setState(request, 'VERIFYING', 'supplier verification started');
      let selectedOption: ProductOption | null = null;
      let selectedSupplier: Supplier | null = null;

      for (let i = 0; i < byPrice.length; i++) {
        const candidate = byPrice[i] as ProductOption;
        const [identityResult, placeResult] = await Promise.all([
          enrichCompany({ name: candidate.merchant_name, domain: candidate.merchant_domain }),
          verifyPlace({ name: candidate.merchant_name, address: candidate.merchant_domain }),
        ]);
        const { verdict, evidence } = evaluateSupplier(identityResult.data, placeResult.data, now);
        const supplier: Supplier = {
          id: `sup_${randomUUID()}`,
          merchant_name: candidate.merchant_name,
          merchant_domain: candidate.merchant_domain,
          identity: identityResult.data,
          place: toPlaceRecord(placeResult.data),
          verdict,
          evidence,
        };
        await store.putSupplier(requestId, supplier);
        await emit('supplier.evaluated', {
          supplier,
          option_id: candidate.id,
          adapter_telemetry: [identityResult.telemetry, placeResult.telemetry],
        });

        if (verdict === 'BLOCKED') {
          request.rejected_supplier_ids.push(supplier.id);
          await store.putRequest(request);
          await emit('supplier.rejected', {
            supplier_id: supplier.id,
            merchant_name: supplier.merchant_name,
            option_id: candidate.id,
            evidence,
            reason: 'supplier could not be verified as a currently-operating business',
          });
          const hasNext = i + 1 < byPrice.length;
          if (hasNext) {
            // THE critical edge: rejection sends us back to sourcing for the next candidate.
            await setState(request, 'SOURCED', `supplier ${supplier.merchant_name} rejected — re-sourcing`);
            await setState(request, 'VERIFYING', 'verifying next candidate supplier');
          }
          continue;
        }

        selectedOption = candidate;
        selectedSupplier = supplier;
        break;
      }

      if (selectedOption === null || selectedSupplier === null) {
        await setState(request, 'BLOCKED', 'all candidate suppliers were rejected');
        await emit('run.blocked', { reason: 'ALL_SUPPLIERS_BLOCKED' });
        await finishRun('BLOCKED');
        return;
      }

      request.selected_option_id = selectedOption.id;
      await store.putRequest(request);

      // 4. Destination check --------------------------------------------------
      const addressInput = request.delivery_address ?? '';
      const destResult = await verifyPlace({ address: addressInput });
      const destEval = evaluateDestination(destResult.data, now);
      const destination: DestinationCheck = {
        request_id: requestId,
        address_input: addressInput,
        resolved_address: destResult.data.formatted_address,
        business_status: destResult.data.business_status,
        receiving_phone: destResult.data.phone,
        verdict: destEval.verdict,
        evidence: destEval.evidence,
      };
      await store.putDestinationCheck(destination);
      await emit('destination.verified', { destination }, destResult.telemetry);

      if (destination.business_status === 'CLOSED_PERMANENTLY') {
        await setState(request, 'BLOCKED', 'delivery destination is permanently closed');
        await emit('run.blocked', { reason: 'DESTINATION_CLOSED' });
        await finishRun('BLOCKED');
        return;
      }

      // 5. Freight quote ------------------------------------------------------
      const cfg = getConfig();
      const pallets = Math.max(1, Math.ceil(quantity / cfg.unitsPerPallet));
      const zipMatch = /\b(\d{5})(?:-\d{4})?\b/.exec(destination.resolved_address ?? addressInput);
      const destZip = zipMatch?.[1] ?? '00000';
      const quoteResult = await quoteFreight({
        dest_zip: destZip,
        pallets,
        ready_date: now.slice(0, 10),
      });
      const quote = {
        ...quoteResult.data,
        request_id: requestId,
        meets_deadline:
          request.deadline === null || quoteResult.data.estimated_delivery <= request.deadline,
      };
      await store.putFreightQuote(quote);
      await emit('freight.quoted', { quote }, quoteResult.telemetry);

      // Now that freight is known, the selected option is the best landed value.
      const storedOptions = await store.getOptions(requestId);
      for (const option of storedOptions) {
        if (option.id === selectedOption.id) option.label = 'BEST_LANDED_VALUE';
      }
      await store.putOptions(requestId, storedOptions);
      await emit('options.relabeled', {
        labels: storedOptions.map((o) => ({ option_id: o.id, label: o.label })),
      });

      // 6. Landed cost ----------------------------------------------------------
      const landed = computeLandedCost({
        product_cents: selectedOption.extended_price_cents,
        freight_cents: quote.cost_cents,
        budget_cents: request.budget_max_cents,
        retail_parcel_baseline_cents: quote.retail_parcel_baseline_cents,
      });
      await store.putLandedCost(requestId, landed);
      await emit('cost.computed', { landed_cost: landed });
      await setState(request, 'QUOTED', 'landed cost computed');

      // 7. Approval chain ---------------------------------------------------------
      const policy = requiredApproval({
        total_cents: landed.total_cents,
        supplier_verdict: selectedSupplier.verdict,
      });
      await store.putApprovalChain({
        request_id: requestId,
        tier: policy.tier,
        required_roles: policy.required_roles,
        satisfied_roles: [],
        decisions: [],
        status: 'PENDING',
        escalation_reason: policy.escalation_reason,
      });
      await emit('approval.required', {
        tier: policy.tier,
        required_roles: policy.required_roles,
        escalation_reason: policy.escalation_reason,
        total_cents: landed.total_cents,
        destination_phone: destination.receiving_phone,
      });
      await setState(request, 'AWAITING_APPROVAL', `approval tier ${policy.tier}`);

      // Approvals and the outbound call are client-triggered from here.
      await finishRun('AWAITING_APPROVAL');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, runId, requestId }, 'run failed');
      const fresh = await store.getRequest(requestId);
      if (fresh !== null && ['DRAFT', 'PARSED', 'SOURCING'].includes(fresh.state)) {
        await setState(fresh, 'FAILED', `run failed: ${message}`);
      }
      await emit('run.failed', { reason: message });
      await finishRun('FAILED');
    }
  }

  return { startRun, waitForRun };
}
