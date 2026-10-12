/**
 * Property-based test for great-circle distance.
 *
 * Feature: load-energy — Property 8 (task 5.5).
 *
 * Drives the real `haversineMiles` with generated coordinate pairs: no mocks,
 * no fakes, nothing but the pure function under test.
 *
 * Symmetry is asserted as STRICT equality (`toBe`), not a tolerance. The
 * implementation documents itself as bitwise symmetric by construction — it
 * feeds `sin` the absolute deltas and multiplies the two cosines in a fixed
 * order — so the two argument orders are literally the same floating-point
 * computation. A tolerance here would hide a real regression.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_LAT, MAX_LNG, MIN_LAT, MIN_LNG } from "@/domain/types";
import { haversineMiles } from "./geo";

// ---------------------------------------------------------------------------
// Coordinate generators — the full valid range, weighted to also hit the poles,
// the antimeridian, the equator, and the Phoenix pilot area.
// ---------------------------------------------------------------------------

const latitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LAT, max: MAX_LAT, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(
      MIN_LAT,
      MAX_LAT,
      0,
      -0,
      33.3703,
      33.4484,
      33.4353,
      89.999999
    ),
    weight: 1,
  }
);

const longitude = fc.oneof(
  {
    arbitrary: fc.double({ min: MIN_LNG, max: MAX_LNG, noNaN: true }),
    weight: 4,
  },
  {
    arbitrary: fc.constantFrom(
      MIN_LNG,
      MAX_LNG,
      0,
      -0,
      -112.5838,
      -112.074,
      -112.3576,
      179.999999
    ),
    weight: 1,
  }
);

const coordinate = fc.record({ lat: latitude, lng: longitude });

/**
 * A pair of coordinates. Three shapes, so the "equals zero when a == b" half of
 * the property is exercised by the same run as the general case:
 *   - two independent points (including antipodal-ish pairs);
 *   - the same point by value (a fresh object with identical fields);
 *   - the very same object reference.
 */
const coordinatePair = fc.oneof(
  {
    arbitrary: fc
      .tuple(coordinate, coordinate)
      .map(([a, b]) => ({ a, b, equal: a.lat === b.lat && a.lng === b.lng })),
    weight: 5,
  },
  {
    arbitrary: coordinate.map((a) => ({ a, b: { ...a }, equal: true })),
    weight: 2,
  },
  {
    arbitrary: coordinate.map((a) => ({ a, b: a, equal: true })),
    weight: 1,
  }
);

describe("Property 8: Haversine distance is well-formed", () => {
  // Feature: load-energy, Property 8: Haversine distance is well-formed
  // **Validates: Requirements 4.2**
  it("is non-negative, exactly zero for identical points, and exactly symmetric", () => {
    fc.assert(
      fc.property(coordinatePair, ({ a, b, equal }) => {
        const forward = haversineMiles(a, b);
        const reverse = haversineMiles(b, a);

        // Well-formed: a real, finite, non-negative number of miles.
        expect(Number.isFinite(forward)).toBe(true);
        expect(forward).toBeGreaterThanOrEqual(0);

        // Symmetric — exactly, not approximately.
        expect(reverse).toBe(forward);

        // Zero exactly when the two coordinates are the same point.
        if (equal) {
          expect(forward).toBe(0);
        }

        // And the identity case holds for any generated point, however it was
        // drawn: distance to a copy of itself, and to itself, is exactly 0.
        expect(haversineMiles(a, { ...a })).toBe(0);
        expect(haversineMiles(a, a)).toBe(0);
        expect(haversineMiles(b, { ...b })).toBe(0);
      })
    );
  });
});
