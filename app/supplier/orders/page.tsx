import { AppShell } from "../../_components/app-shell";
import { SupplierOrders } from "../../_components/supplier-orders";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** Won orders, en route, and the BOL (Requirements 8.7, 10.2, 11.1, 11.6). */
export default async function SupplierOrdersPage() {
  const session = await requireSession("supplier");

  return (
    <AppShell
      session={session}
      activeNavId="won-orders"
      title="Won orders"
      lede="Mark en route, then record the BOL when the fuel lands."
    >
      <SupplierOrders />
    </AppShell>
  );
}
