import { AppShell } from "../../_components/app-shell";
import { AdminSuppliers } from "../../_components/admin-suppliers";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** Approval, Operating_Location, Service_Radius (Requirements 16.2, 16.4, 16.5). */
export default async function AdminSuppliersPage() {
  const session = await requireSession("admin");

  return (
    <AppShell
      session={session}
      activeNavId="suppliers"
      title="Suppliers"
      lede="Approve a company, then set where it works from and how far it goes."
    >
      <AdminSuppliers />
    </AppShell>
  );
}
