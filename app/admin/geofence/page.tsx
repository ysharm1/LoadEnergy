import { AppShell } from "../../_components/app-shell";
import { AdminGeofence } from "../../_components/admin-geofence";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The Pilot_Geofence editor (Requirement 16.7). */
export default async function AdminGeofencePage() {
  const session = await requireSession("admin");

  return (
    <AppShell
      session={session}
      activeNavId="geofence"
      title="Pilot geofence"
      lede="The bounding box new requests must fall inside."
    >
      <AdminGeofence />
    </AppShell>
  );
}
