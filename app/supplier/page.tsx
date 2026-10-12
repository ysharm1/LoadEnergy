import { AppShell } from "../_components/app-shell";
import { SupplierRfqInbox } from "../_components/supplier-rfq-inbox";
import { requireSession } from "../_lib/session";

export const dynamic = "force-dynamic";

/** The supplier RFQ inbox and quote box (Requirements 4.3, 6.1, 6.2). */
export default async function SupplierHomePage() {
  const session = await requireSession("supplier");

  return (
    <AppShell
      session={session}
      activeNavId="rfqs"
      title="RFQ inbox"
      lede="Live loads in your radius. Quote a landed price and a hold."
    >
      <SupplierRfqInbox />
    </AppShell>
  );
}
