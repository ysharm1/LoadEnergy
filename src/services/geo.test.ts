import { describe, expect, it } from "vitest";
import {
  EARTH_RADIUS_MILES,
  haversineMiles,
  isWithinRadius,
  operatingLocationOf,
} from "./geo";

// Reference points with well-published great-circle separations.
const PHOENIX = { lat: 33.4484, lng: -112.074 };
const TUCSON = { lat: 32.2226, lng: -110.9747 };
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
const LOS_ANGELES = { lat: 34.0522, lng: -118.2437 };

describe("haversineMiles", () => {
  it("returns zero for identical coordinates", () => {
    expect(haversineMiles(PHOENIX, { ...PHOENIX })).toBe(0);
  });

  it("matches the Phoenix-Tucson great-circle distance (~106 mi)", () => {
    // Equirectangular cross-check: 1.2258 deg lat = 84.8 mi, 1.0993 deg lng at
    // lat 32.8 = 63.9 mi, hypotenuse 106.1 mi.
    expect(haversineMiles(PHOENIX, TUCSON)).toBeCloseTo(106, 0);
  });

  it("matches the published Phoenix-Los Angeles distance (~357 mi)", () => {
    expect(haversineMiles(PHOENIX, LOS_ANGELES)).toBeCloseTo(357, 0);
  });

  it("is short across the SW Valley (Phoenix to Buckeye, ~30 mi)", () => {
    expect(haversineMiles(PHOENIX, BUCKEYE)).toBeCloseTo(30, 0);
  });

  it("is exactly symmetric for swapped arguments", () => {
    // Exact equality, not a tolerance: the implementation is bitwise symmetric.
    expect(haversineMiles(PHOENIX, TUCSON)).toBe(haversineMiles(TUCSON, PHOENIX));
    expect(haversineMiles(BUCKEYE, LOS_ANGELES)).toBe(
      haversineMiles(LOS_ANGELES, BUCKEYE)
    );
  });

  it("spans half the circumference between antipodal points", () => {
    const north = { lat: 0, lng: 0 };
    const antipode = { lat: 0, lng: 180 };
    expect(haversineMiles(north, antipode)).toBeCloseTo(
      Math.PI * EARTH_RADIUS_MILES,
      6
    );
  });

  it("handles the poles without clamping error", () => {
    const distance = haversineMiles({ lat: 90, lng: 0 }, { lat: -90, lng: 137 });
    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_MILES, 6);
  });

  it("treats longitude wrap as a great-circle span, not a numeric gap", () => {
    // 179E to 179W is 2 degrees apart at the equator, not 358.
    const near = haversineMiles({ lat: 0, lng: 179 }, { lat: 0, lng: -179 });
    const reference = haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 2 });
    expect(near).toBeCloseTo(reference, 6);
  });

  it("returns NaN for a non-finite coordinate", () => {
    expect(haversineMiles({ lat: Number.NaN, lng: 0 }, PHOENIX)).toBeNaN();
    expect(haversineMiles(PHOENIX, { lat: 0, lng: Number.POSITIVE_INFINITY })).toBeNaN();
  });
});

describe("isWithinRadius", () => {
  it("admits a pin inside the radius", () => {
    expect(isWithinRadius(PHOENIX, BUCKEYE, 50)).toBe(true);
  });

  it("excludes a pin outside the radius", () => {
    expect(isWithinRadius(PHOENIX, BUCKEYE, 10)).toBe(false);
  });

  it("is inclusive at exactly the radius", () => {
    const exact = haversineMiles(PHOENIX, BUCKEYE);
    expect(isWithinRadius(PHOENIX, BUCKEYE, exact)).toBe(true);
  });

  it("admits the origin itself for any positive radius", () => {
    expect(isWithinRadius(BUCKEYE, { ...BUCKEYE }, 0.0001)).toBe(true);
  });

  it("fails closed with no operating location configured", () => {
    expect(isWithinRadius(PHOENIX, null, 50)).toBe(false);
    expect(isWithinRadius(PHOENIX, undefined, 50)).toBe(false);
  });

  it("fails closed with no radius configured", () => {
    expect(isWithinRadius(PHOENIX, BUCKEYE, null)).toBe(false);
    expect(isWithinRadius(PHOENIX, BUCKEYE, undefined)).toBe(false);
  });

  it("fails closed for a non-positive or non-finite radius", () => {
    expect(isWithinRadius(PHOENIX, BUCKEYE, 0)).toBe(false);
    expect(isWithinRadius(PHOENIX, BUCKEYE, -25)).toBe(false);
    expect(isWithinRadius(PHOENIX, BUCKEYE, Number.NaN)).toBe(false);
    expect(isWithinRadius(PHOENIX, BUCKEYE, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("fails closed for a malformed pin", () => {
    expect(isWithinRadius({ lat: Number.NaN, lng: -112 }, BUCKEYE, 500)).toBe(false);
  });
});

describe("operatingLocationOf", () => {
  it("lifts a configured operating pin", () => {
    expect(operatingLocationOf({ operatingLat: 33.37, operatingLng: -112.58 })).toEqual(
      { lat: 33.37, lng: -112.58 }
    );
  });

  it("returns null when either coordinate is unset", () => {
    expect(operatingLocationOf({ operatingLat: 33.37, operatingLng: null })).toBeNull();
    expect(operatingLocationOf({ operatingLat: null, operatingLng: -112.58 })).toBeNull();
    expect(operatingLocationOf({ operatingLat: null, operatingLng: null })).toBeNull();
  });
});
