import type { Evidence, PlaceInfo, Supplier, Verdict } from '../types.js';

export const STALE_AFTER_DAYS = 120;

const DAY_MS = 86_400_000;

/**
 * Strictly stale: we AFFIRMATIVELY know the last verification is older than
 * the threshold. A missing last_verified_at is unknown, not stale — missing
 * data alone never contributes to BLOCKED.
 */
function isAffirmativelyStale(lastVerifiedAt: string | null, now: string): boolean {
  if (lastVerifiedAt === null) return false;
  const last = Date.parse(lastVerifiedAt);
  const at = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(at)) return false;
  return (at - last) / DAY_MS > STALE_AFTER_DAYS;
}

/** Stale OR unconfirmed (used for CONFLICTING, which is not a blocking verdict). */
function isStaleOrUnconfirmed(place: PlaceInfo): boolean {
  return place.last_verified_at === null || place.business_status === 'UNKNOWN';
}

function identityResolved(identity: Supplier['identity']): boolean {
  return identity !== null && identity.legal_name !== null;
}

function identitySaysOperating(identity: Supplier['identity']): boolean {
  return identity !== null && identity.last_activity_signal !== null;
}

/**
 * Combine CrustData identity + VOYGR place signals into a verdict with
 * evidence. Pure — `now` is a parameter so tests and replays are
 * deterministic. Rules apply in priority order; only affirmative negative
 * evidence can produce BLOCKED. Every verdict returns non-empty evidence[].
 */
export function evaluateSupplier(
  identity: Supplier['identity'],
  place: PlaceInfo | null,
  now: string,
): { verdict: Verdict; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  const observed_at = now;

  if (place !== null) {
    evidence.push({
      source: 'voygr',
      claim: 'business_status',
      value: place.business_status,
      observed_at,
      supports:
        place.business_status === 'OPERATIONAL'
          ? 'positive'
          : place.business_status === 'UNKNOWN'
            ? 'neutral'
            : 'negative',
    });
  }
  if (identitySaysOperating(identity) && identity !== null) {
    evidence.push({
      source: 'crustdata',
      claim: 'activity_signal',
      value: identity.last_activity_signal as string,
      observed_at,
      supports: 'positive',
    });
  } else if (identityResolved(identity) && identity !== null) {
    evidence.push({
      source: 'crustdata',
      claim: 'identity',
      value: `resolved legal entity ${identity.legal_name as string}`,
      observed_at,
      supports: 'positive',
    });
  }

  // Rule 1: affirmative closure.
  if (place !== null && place.business_status === 'CLOSED_PERMANENTLY') {
    return { verdict: 'BLOCKED', evidence };
  }

  // Rule 2: disconnected phone AND affirmatively stale verification.
  if (
    place !== null &&
    place.phone_status === 'DISCONNECTED' &&
    isAffirmativelyStale(place.last_verified_at, now)
  ) {
    evidence.push({
      source: 'voygr',
      claim: 'phone_status',
      value: `listed phone ${place.phone ?? '(unknown number)'} is disconnected`,
      observed_at,
      supports: 'negative',
    });
    evidence.push({
      source: 'voygr',
      claim: 'last_verified_at',
      value: `address unconfirmed since ${(place.last_verified_at as string).slice(0, 10)}`,
      observed_at,
      supports: 'negative',
    });
    return { verdict: 'BLOCKED', evidence };
  }

  // Rule 3: identity says operating, place says unconfirmed/stale.
  if (
    identitySaysOperating(identity) &&
    place !== null &&
    (isStaleOrUnconfirmed(place) || isAffirmativelyStale(place.last_verified_at, now))
  ) {
    evidence.push({
      source: 'voygr',
      claim: 'last_verified_at',
      value:
        place.last_verified_at === null
          ? 'place record has never been verified'
          : `place record stale since ${place.last_verified_at.slice(0, 10)}`,
      observed_at,
      supports: 'negative',
    });
    return { verdict: 'CONFLICTING', evidence };
  }

  const placeOperational = place !== null && place.business_status === 'OPERATIONAL';
  const placeFresh =
    place !== null &&
    place.last_verified_at !== null &&
    !isAffirmativelyStale(place.last_verified_at, now);

  // Rule 5 (checked before 4's fall-through): operational + resolved + fresh.
  if (placeOperational && placeFresh && identityResolved(identity)) {
    evidence.push({
      source: 'voygr',
      claim: 'last_verified_at',
      value: `place verified on ${(place.last_verified_at as string).slice(0, 10)}`,
      observed_at,
      supports: 'positive',
    });
    return { verdict: 'VERIFIED', evidence };
  }

  // Rule 4: operational place but unresolvable identity.
  if (placeOperational && !identityResolved(identity)) {
    evidence.push({
      source: 'crustdata',
      claim: 'identity',
      value: 'company identity could not be resolved',
      observed_at,
      supports: 'neutral',
    });
    return { verdict: 'NEEDS_CONFIRMATION', evidence };
  }

  // Rule 6: anything else. Missing data alone never yields BLOCKED.
  if (evidence.length === 0) {
    evidence.push({
      source: 'human',
      claim: 'signals',
      value: 'no identity or place signals available — manual confirmation required',
      observed_at,
      supports: 'neutral',
    });
  }
  return { verdict: 'NEEDS_CONFIRMATION', evidence };
}

/**
 * Destination verdict. Same evidence discipline: only a place affirmatively
 * marked CLOSED_PERMANENTLY blocks; anything unconfirmed needs confirmation.
 */
export function evaluateDestination(
  place: PlaceInfo | null,
  now: string,
): { verdict: Verdict; evidence: Evidence[] } {
  const observed_at = now;
  if (place === null) {
    return {
      verdict: 'NEEDS_CONFIRMATION',
      evidence: [
        {
          source: 'voygr',
          claim: 'place_lookup',
          value: 'destination address could not be resolved to a place record',
          observed_at,
          supports: 'neutral',
        },
      ],
    };
  }

  const evidence: Evidence[] = [
    {
      source: 'voygr',
      claim: 'business_status',
      value: place.business_status,
      observed_at,
      supports:
        place.business_status === 'OPERATIONAL'
          ? 'positive'
          : place.business_status === 'UNKNOWN'
            ? 'neutral'
            : 'negative',
    },
  ];

  if (place.business_status === 'CLOSED_PERMANENTLY') {
    return { verdict: 'BLOCKED', evidence };
  }

  if (
    place.business_status === 'OPERATIONAL' &&
    place.last_verified_at !== null &&
    !isAffirmativelyStale(place.last_verified_at, now)
  ) {
    if (place.hours_known) {
      evidence.push({
        source: 'voygr',
        claim: 'hours',
        value: 'business hours on record',
        observed_at,
        supports: 'positive',
      });
    }
    if (place.phone !== null && place.phone_status !== 'DISCONNECTED') {
      evidence.push({
        source: 'voygr',
        claim: 'receiving_phone',
        value: `receiving phone ${place.phone} on record`,
        observed_at,
        supports: 'positive',
      });
    }
    return { verdict: 'VERIFIED', evidence };
  }

  return { verdict: 'NEEDS_CONFIRMATION', evidence };
}
