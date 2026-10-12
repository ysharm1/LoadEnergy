/**
 * Pilot_Geofence membership — the bounding-box check applied to every new
 * Request.
 *
 * Requirements:
 *   3.6  a Request whose location pin falls outside the Pilot_Geofence is
 *        rejected with a geofence error (enforced in `RequestService`, decided
 *        here).
 *  16.7  the Admin-configured box (task 3.3, `AdminService.setGeofence` /
 *        `getGeofence`) is what newly created Requests are checked against.
 *
 * Pure and synchronous: no repository, no clock, no I/O. The fence is passed
 * in, so the caller owns "which fence" and this module owns only "inside or
 * not". That is what lets Property 7 drive it with generated boxes and pins.
 *
 * Bounds are INCLUSIVE on all four edges. A pin exactly on an edge (or on a
 * corner) is inside, which keeps the check consistent with the degenerate
 * `min === max` box that `requireGeofence` deliberately allows — such a box
 * admits exactly its one pin rather than nothing at all.
 */

import type { Geofence, LatLng } from "@/domain/types";

/**
 * True when `pin` lies inside `fence`, bounds inclusive.
 *
 * Non-finite inputs (NaN, +/-Infinity) are never inside: every comparison
 * against NaN is false, so the function fails closed rather than admitting a
 * malformed pin. Range and shape validation of the pin and the box happen
 * earlier (`requireLatLng`, `requireGeofence`); this predicate answers only
 * the membership question.
 */
export function isInsideGeofence(pin: LatLng, fence: Geofence): boolean {
  return (
    pin.lat >= fence.minLat &&
    pin.lat <= fence.maxLat &&
    pin.lng >= fence.minLng &&
    pin.lng <= fence.maxLng
  );
}
