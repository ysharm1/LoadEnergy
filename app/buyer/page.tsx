import { AppShell } from "../_components/app-shell";
import { BuyerWorkList } from "../_components/buyer-work-list";
import { requireSession } from "../_lib/session";

export const dynamic = "force-dynamic";

/** The Buyer home: Open Requests and Orders (Requirement 3.9). */
export default async function BuyerHomePage() {
  const session = await requireSession("buyer");

  return (
    <AppShell
      session={session}
      activeNavId="loads"
      title="My loads"
      lede="Open requests, live quotes, and the orders you have running."
    >
      <BuyerWorkList />
    </AppShell>
  );
}
