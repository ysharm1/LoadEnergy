import { AppShell } from "../../../_components/app-shell";
import { NewRequestForm } from "../../../_components/new-request-form";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

/** The single New Request flow (Requirements 3.1, 15.2, 15.3, 15.4). */
export default async function NewRequestPage() {
  const session = await requireSession("buyer");

  return (
    <AppShell
      session={session}
      activeNavId="new-request"
      title="New request"
      lede="One form. Suppliers in range are paged as soon as you post."
    >
      <NewRequestForm />
    </AppShell>
  );
}
