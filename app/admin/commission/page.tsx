import { AppShell } from "../../_components/app-shell";
import { AdminCommission } from "../../_components/admin-commission";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** Commission due by Supplier Company, and mark-paid (Requirements 12.6, 12.8). */
export default async function AdminCommissionPage() {
  const session = await requireSession("admin");

  return (
    <AppShell
      session={session}
      activeNavId="commission"
      title="Commission due"
      lede="Unpaid commission grouped by supplier company."
    >
      <AdminCommission />
    </AppShell>
  );
}
