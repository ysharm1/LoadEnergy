import { AppShell } from "../../_components/app-shell";
import { AdminUsers } from "../../_components/admin-users";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** User onboarding (Requirements 1.3-1.7). */
export default async function AdminUsersPage() {
  const session = await requireSession("admin");

  return (
    <AppShell
      session={session}
      activeNavId="users"
      title="New user"
      lede="Seat a person on a company with one role and a phone number."
    >
      <AdminUsers />
    </AppShell>
  );
}
