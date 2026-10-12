import { describe, expect, it } from "vitest";
import type { Geofence } from "@/domain/types";
import { isInsideGeofence } from "./geofence";

// Phoenix SW Valley-ish pilot box.
const SW_VALLEY: Geofence = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.6,
  maxLng: -112.1,
};

describe("isInsideGeofence", () => {
  it("admits a pin in the interior of the box", () => {
    expect(isInsideGeofence({ lat: 33.4, lng: -112.35 }, SW_VALLEY)).toBe(true);
  });

  it("admits pins on each edge (bounds are inclusive)", () => {
    expect(isInsideGeofence({ lat: 33.2, lng: -112.35 }, SW_VALLEY)).toBe(true);
    expect(isInsideGeofence({ lat: 33.6, lng: -112.35 }, SW_VALLEY)).toBe(true);
    expect(isInsideGeofence({ lat: 33.4, lng: -112.6 }, SW_VALLEY)).toBe(true);
    expect(isInsideGeofence({ lat: 33.4, lng: -112.1 }, SW_VALLEY)).toBe(true);
  });

  it("admits pins on each corner", () => {
    for (const lat of [SW_VALLEY.minLat, SW_VALLEY.maxLat]) {
      for (const lng of [SW_VALLEY.minLng, SW_VALLEY.maxLng]) {
        expect(isInsideGeofence({ lat, lng }, SW_VALLEY)).toBe(true);
      }
    }
  });

  it("rejects pins just outside each edge", () => {
    expect(isInsideGeofence({ lat: 33.1999, lng: -112.35 }, SW_VALLEY)).toBe(false);
    expect(isInsideGeofence({ lat: 33.6001, lng: -112.35 }, SW_VALLEY)).toBe(false);
    expect(isInsideGeofence({ lat: 33.4, lng: -112.6001 }, SW_VALLEY)).toBe(false);
    expect(isInsideGeofence({ lat: 33.4, lng: -112.0999 }, SW_VALLEY)).toBe(false);
  });

  it("admits exactly its one pin for a degenerate min == max box", () => {
    const point: Geofence = {
      minLat: 33.45,
      maxLat: 33.45,
      minLng: -112.4,
      maxLng: -112.4,
    };
    expect(isInsideGeofence({ lat: 33.45, lng: -112.4 }, point)).toBe(true);
    expect(isInsideGeofence({ lat: 33.45, lng: -112.41 }, point)).toBe(false);
  });

  it("fails closed on non-finite pin coordinates", () => {
    expect(isInsideGeofence({ lat: Number.NaN, lng: -112.35 }, SW_VALLEY)).toBe(
      false
    );
    expect(
      isInsideGeofence({ lat: 33.4, lng: Number.POSITIVE_INFINITY }, SW_VALLEY)
    ).toBe(false);
  });
});
