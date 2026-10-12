import { AppShell } from "../../_components/app-shell";
import { BuyerSites } from "../../_components/buyer-sites";
import { requireSession } from "../../_lib/session";

export const dynamic = "force-dynamic";

/** The Company's jobsites (Requirements 2.1, 2.3). */
export default async function BuyerSitesPage() {
  const session = await requireSession("buyer");

  return (
    <AppShell
      session={session}
      activeNavId="sites"
      title="Sites"
      lede="Saved jobsites for this company."
    >
      <BuyerSites />
    </AppShell>
  );
}
