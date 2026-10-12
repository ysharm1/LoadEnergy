import { AppShell } from "../../_components/app-shell";
import { AdminConcierge } from "../../_components/admin-concierge";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** Concierge order entry (Requirements 17.1, 17.2). */
export default async function AdminConciergePage() {
  const session = await requireSession("admin");

  return (
    <AppShell
      session={session}
      activeNavId="concierge"
      title="Concierge order"
      lede="Write down a phone deal. It lands delivered and bills like any win."
    >
      <AdminConcierge />
    </AppShell>
  );
}
