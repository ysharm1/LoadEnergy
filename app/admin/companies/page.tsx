import { AppShell } from "../../_components/app-shell";
import { AdminCompanies } from "../../_components/admin-companies";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** Company onboarding (Requirements 1.3, 16.1). */
export default async function AdminCompaniesPage() {
  const session = await requireSession("admin");

  return (
    <AppShell
      session={session}
      activeNavId="companies"
      title="New company"
      lede="Onboard a buyer or a supplier. Suppliers start pending approval."
    >
      <AdminCompanies />
    </AppShell>
  );
}
