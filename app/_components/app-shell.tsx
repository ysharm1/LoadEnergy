import Link from "next/link";
import type { ReactNode } from "react";
import type { Session } from "../_lib/session";
import { SignOutButton } from "./sign-out-button";

const ROLE_LABELS = {
  buyer: "Buyer",
  supplier: "Supplier",
  admin: "Admin",
} as const;

export interface AppShellProps {
  session: Session;
  /** The `id` of the current nav item, which marks it `aria-current`. */
  activeNavId: string;
  title: string;
  /** One line under the heading, where the screen needs it. */
  lede?: string;
  children: ReactNode;
}

/**
 * The frame every signed-in screen renders inside (Requirement 1.8).
 *
 * Navigation comes from `session.surface`, which is `interfaceForRole` —
 * the same descriptor that lists the role's capabilities — so a role is never
 * shown a link to a surface its services would deny.
 */
export function AppShell({
  session,
  activeNavId,
  title,
  lede,
  children,
}: AppShellProps) {
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-identity">
          <span className="shell-role">{ROLE_LABELS[session.ctx.role]}</span>
          <span className="shell-company">
            {session.companyName ?? "Load Energy"}
          </span>
        </div>
        <SignOutButton />
      </header>

      <nav className="shell-nav" aria-label="Primary">
        <ul>
          {session.surface.navigation.map((item) => (
            <li key={item.id}>
              <Link
                href={item.path}
                aria-current={item.id === activeNavId ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <main className="shell-main">
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
        {children}
      </main>
    </div>
  );
}
