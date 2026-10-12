import { AppShell } from "../../_components/app-shell";
import { SupplierStatusToggle } from "../../_components/supplier-status-toggle";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The Supplier_Status toggle (Requirements 5.1, 5.2). */
export default async function SupplierStatusPage() {
  const session = await requireSession("supplier");

  return (
    <AppShell
      session={session}
      activeNavId="availability"
      title="Availability"
      lede="Open and Limited receive RFQs. Closed receives none."
    >
      <SupplierStatusToggle />
    </AppShell>
  );
}
