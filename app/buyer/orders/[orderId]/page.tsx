import { AppShell } from "../../../_components/app-shell";
import { OrderStatus } from "../../../_components/order-status";
import { requireSession } from "../../../_lib/session";

export const dynamic = "force-dynamic";

/** The buyer order status view (Requirement 10.6). */
export default async function BuyerOrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const session = await requireSession("buyer");
  const { orderId } = await params;

  return (
    <AppShell
      session={session}
      activeNavId="loads"
      title="Order"
      lede="Where this load is right now."
    >
      <OrderStatus orderId={orderId} />
    </AppShell>
  );
}
