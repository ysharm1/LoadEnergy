import { redirect } from "next/navigation";
import { SignInForm } from "./_components/sign-in-form";
import { currentSession } from "./_lib/session";

/** The session is read per request, so this entry point is never static. */
export const dynamic = "force-dynamic";

/**
 * The app's front door (Requirements 1.8, 15.1).
 *
 * A signed-in caller is sent straight to the home of their role's surface, so
 * opening the installed app lands on the right interface with no menu step. An
 * unauthenticated caller gets sign-in, which is also the shell the service
 * worker caches for offline launches.
 */
export default async function HomePage() {
  const session = await currentSession();
  if (session) redirect(session.surface.homePath);

  return (
    <main className="shell-main">
      <h1>Load Energy</h1>
      <p className="lede">
        Phoenix-first commercial diesel load board. Post a load, get a landed
        price, track delivery.
      </p>
      <SignInForm />
    </main>
  );
}
