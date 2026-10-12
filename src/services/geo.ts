/**
 * Great-circle distance and the Service_Radius check.
 *
 * Requirements:
 *   4.2 the distance between a Request's location pin and a Supplier Company's
 *       Operating_Location is computed using great-circle distance.
 *   4.4 a pin outside a Supplier Company's Service_Radius excludes the Request
 *       from that Company's RFQ inbox (the decision lives here; the filtering
 *       lives in `services/matching.ts`).
 *
 * Pure and synchronous, like `services/geofence.ts`: no repository, no clock,
 * no I/O. Everything the caller needs is passed in, which is what lets
 * Property 8 drive `haversineMiles` with generated coordinate pairs.
 *
 * ## Exact symmetry
 *
 * Property 8 requires `distance(a, b) === distance(b, a)` exactly, not merely
 * within a tolerance. The implementation below is bitwise symmetric by
 * construction, and that is deliberate:
 *
 *   - The latitude/longitude deltas are taken as ABSOLUTE differences. IEEE-754
 *     subtraction is exactly rounded, so `b.lat - a.lat` and `a.lat - b.lat`
 *     are exact negations of one another and `Math.abs` maps both to the same
 *     bit pattern. Feeding `sin()` the same argument in both argument orders
 *     removes any dependence on `sin` being exactly odd, which the spec does
 *     not guarantee for a platform's libm.
 *   - The only other place the two points meet is the product
 *     `cos(φa) * cos(φb)`. IEEE-754 multiplication is commutative, so swapping
 *     the operands yields the identical result.
 *
 * Every remaining operation sees identical inputs in an identical order, so the
 * two evaluations are the same floating-point computation, not just
 * mathematically equal ones. No tolerance is needed.
 */

import type { LatLng } from "@/domain/types";

/**
 * Earth's mean radius in statute miles.
 *
 * Derived from the IUGG mean radius R1 = 6371.0088 km, converted with the
 * international mile (1 mi = 1.609344 km exactly):
 *   6371.0088 / 1.609344 = 3958.7613... mi
 *
 * A spherical-earth model is accurate to roughly 0.5% — far inside the
 * tolerance of a pilot service radius quoted in whole miles.
 */
export const EARTH_RADIUS_MILES = 3958.7613;

const DEG_TO_RAD = Math.PI / 180;

function toRadians(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Great-circle distance between two coordinates, in miles (Requirement 4.2).
 *
 * Returns `NaN` for a non-finite input coordinate rather than a misleading
 * number: callers that must decide admittance (`isWithinRadius`) fail closed on
 * `NaN`, because every comparison against it is false. Range validation of
 * coordinates happens upstream (`requireLatLng`); this function answers only
 * "how far apart".
 *
 * Guarantees (Property 8): the result is non-negative, is exactly `0` when the
 * two coordinates are equal, and is exactly symmetric in its arguments.
 */
export function haversineMiles(a: LatLng, b: LatLng): number {
  if (
    !isFiniteNumber(a?.lat) ||
    !isFiniteNumber(a?.lng) ||
    !isFiniteNumber(b?.lat) ||
    !isFiniteNumber(b?.lng)
  ) {
    return Number.NaN;
  }

  // Absolute deltas: identical bit patterns whichever way the arguments come in.
  const dLat = toRadians(Math.abs(b.lat - a.lat));
  const dLng = toRadians(Math.abs(b.lng - a.lng));

  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLng = Math.sin(dLng / 2);

  // cos(φa) * cos(φb) — commutative under IEEE-754 multiplication.
  const cosLatProduct = Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat));

  const h =
    sinHalfDLat * sinHalfDLat + cosLatProduct * sinHalfDLng * sinHalfDLng;

  // Rounding can push h a hair outside [0, 1] for antipodal-ish inputs, which
  // would make asin return NaN. Clamp instead.
  const clamped = h < 0 ? 0 : h > 1 ? 1 : h;

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(clamped));
}

/**
 * True when `pin` lies within `radiusMiles` of `operatingLocation`
 * (Requirements 4.2, 4.4).
 *
 * The radius is INCLUSIVE: a pin exactly `radiusMiles` away is inside, which
 * matches the inclusive edges used by the Pilot_Geofence check and means an
 * Admin-set radius describes the last mile a supplier will serve rather than
 * the first mile it refuses.
 *
 * Fails closed — returns `false` — when the Supplier Company has no
 * Admin-configured Operating_Location or Service_Radius yet (either is null),
 * or when any value is non-finite or the radius is not positive. An
 * unconfigured supplier is not a supplier that serves everywhere; it is one
 * that cannot be matched until an Admin configures it (Requirement 4.7).
 */
export function isWithinRadius(
  pin: LatLng,
  operatingLocation: LatLng | null | undefined,
  radiusMiles: number | null | undefined
): boolean {
  if (operatingLocation == null) return false;
  if (!isFiniteNumber(radiusMiles) || radiusMiles <= 0) return false;

  const distance = haversineMiles(pin, operatingLocation);
  // NaN (a malformed coordinate) fails this comparison, so it fails closed.
  return distance <= radiusMiles;
}

/**
 * Convenience over the nullable columns a Supplier Company actually stores:
 * `operatingLat` / `operatingLng` are null until an Admin sets them, so this
 * lifts them into a `LatLng` only when BOTH are present.
 */
export function operatingLocationOf(company: {
  operatingLat: number | null;
  operatingLng: number | null;
}): LatLng | null {
  if (company == null) return null;
  const { operatingLat, operatingLng } = company;
  if (!isFiniteNumber(operatingLat) || !isFiniteNumber(operatingLng)) {
    return null;
  }
  return { lat: operatingLat, lng: operatingLng };
}
