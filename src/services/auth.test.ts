/**
 * Auth unit tests — login success and invalid-credential rejection.
 *
 * Requirements:
 *   1.1 valid credentials authenticate the User and establish a session.
 *   1.2 invalid credentials are rejected with an authentication error.
 *
 * Real collaborators throughout (in-memory repository, in-memory session
 * store, real bcrypt at a low cost, real user creation) so the tests exercise
 * genuine hashing and genuine session state — no mocks.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AuthenticationError } from "@/domain/errors";
import {
  SESSION_COOKIE_NAME,
  readSessionToken,
  serializeSessionCookie,
} from "@/http/session-cookie";
import { InMemoryRepository } from "@/repository/in-memory";
import { InMemorySessionStore } from "@/session/store";
import { AuthService, DEFAULT_SESSION_TTL_MS } from "./auth";
import { CompanyUserService } from "./company-user";
import { BcryptPasswordHasher } from "./password";

const NOW = new Date("2025-03-04T15:00:00Z");
const PHONE = "+16025550134";
const PASSWORD = "correct horse battery staple";

// Cost 4 keeps bcrypt real but fast enough for a unit suite.
const hasher = new BcryptPasswordHasher(4);

interface Harness {
  repo: InMemoryRepository;
  sessions: InMemorySessionStore;
  auth: AuthService;
  users: CompanyUserService;
}

function makeHarness(): Harness {
  const repo = new InMemoryRepository();
  const sessions = new InMemorySessionStore();
  return {
    repo,
    sessions,
    auth: new AuthService({ repo, sessions, hasher }),
    users: new CompanyUserService({ repo, hasher }),
  };
}

async function seedUser(
  h: Harness,
  overrides: { phone?: string; email?: string | null; role?: "buyer" | "supplier" | "admin" } = {}
) {
  const company = await h.users.createCompany(
    { name: "SW Valley Concrete", kind: "buyer" },
    NOW
  );
  const user = await h.users.createUser(
    {
      companyId: company.id,
      role: overrides.role ?? "buyer",
      phone: overrides.phone ?? PHONE,
      email: overrides.email,
      password: PASSWORD,
    },
    NOW
  );
  return { company, user };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

describe("login (Requirement 1.1)", () => {
  it("establishes a session for a valid phone + password pair", async () => {
    const { company, user } = await seedUser(h);

    const result = await h.auth.login(
      { identifier: PHONE, password: PASSWORD },
      NOW
    );

    expect(result.user.id).toBe(user.id);
    expect(result.company.id).toBe(company.id);
    expect(result.token).toBeTruthy();
    // The raw token is never the stored value.
    expect(result.session.tokenHash).not.toBe(result.token);
    expect(result.session.userId).toBe(user.id);
    expect(result.session.createdAt).toEqual(NOW);
    expect(result.session.expiresAt).toEqual(
      new Date(NOW.getTime() + DEFAULT_SESSION_TTL_MS)
    );

    // The issued token resolves to the caller's identity, company, and role.
    await expect(
      h.auth.resolveAuthContext(result.token, NOW)
    ).resolves.toEqual({
      userId: user.id,
      companyId: company.id,
      role: "buyer",
    });
  });

  it("accepts the email the User supplied (Requirement 1.7)", async () => {
    const { user } = await seedUser(h, { email: "ops@example.com" });

    const result = await h.auth.login(
      { identifier: "ops@example.com", password: PASSWORD },
      NOW
    );

    expect(result.user.id).toBe(user.id);
    await expect(h.auth.resolveAuthContext(result.token, NOW)).resolves.toMatchObject(
      { userId: user.id }
    );
  });

  it("matches a stored email regardless of case or surrounding whitespace", async () => {
    // Regression: emails are stored trimmed and lower-cased, so a login
    // identifier must be normalized the same way before lookup. Signing up as
    // `Ops@Example.com` and typing it back must work.
    const { user } = await seedUser(h, { email: "Ops@Example.com" });
    expect((await h.repo.getUser(user.id))?.email).toBe("ops@example.com");

    for (const typed of [
      "Ops@Example.com",
      "OPS@EXAMPLE.COM",
      "  ops@example.com  ",
    ]) {
      const result = await h.auth.login(
        { identifier: typed, password: PASSWORD },
        NOW
      );
      expect(result.user.id).toBe(user.id);
    }
  });

  it("accepts a phone number typed with human formatting", async () => {
    const { user } = await seedUser(h);

    const result = await h.auth.login(
      { identifier: " +1 (602) 555-0134 ", password: PASSWORD },
      NOW
    );

    expect(result.user.id).toBe(user.id);
  });
});

describe("login rejection (Requirement 1.2)", () => {
  it("rejects a wrong password with an authentication error", async () => {
    await seedUser(h);

    const promise = h.auth.login(
      { identifier: PHONE, password: "wrong-password" },
      NOW
    );

    await expect(promise).rejects.toBeInstanceOf(AuthenticationError);
    await expect(promise).rejects.toMatchObject({
      category: "authentication",
      code: "INVALID_CREDENTIALS",
    });
  });

  it("rejects an unknown identifier with the same code (no user enumeration)", async () => {
    await seedUser(h, { email: "ops@example.com" });

    const wrongPassword = await captureLoginError(PHONE, "wrong-password");
    const unknownPhone = await captureLoginError("+16025559999", PASSWORD);
    const unknownEmail = await captureLoginError(
      "nobody@example.com",
      PASSWORD
    );

    for (const error of [wrongPassword, unknownPhone, unknownEmail]) {
      expect(error.code).toBe("INVALID_CREDENTIALS");
    }
    // Identical message too — the response says nothing about which side failed.
    expect(unknownPhone.message).toBe(wrongPassword.message);
    expect(unknownEmail.message).toBe(wrongPassword.message);
  });

  it("rejects an empty identifier and an empty password", async () => {
    await seedUser(h);

    await expect(
      h.auth.login({ identifier: "   ", password: PASSWORD }, NOW)
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    await expect(
      h.auth.login({ identifier: PHONE, password: "" }, NOW)
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("creates no session when login fails", async () => {
    await seedUser(h);

    await expect(
      h.auth.login({ identifier: PHONE, password: "nope" }, NOW)
    ).rejects.toBeInstanceOf(AuthenticationError);

    await expect(h.auth.resolveAuthContext("any-token", NOW)).resolves.toBeNull();
  });
});

describe("session resolution", () => {
  it("returns null for a missing, unknown, or tampered token", async () => {
    const { token } = await loginFresh();

    await expect(h.auth.resolveAuthContext(null, NOW)).resolves.toBeNull();
    await expect(h.auth.resolveAuthContext(undefined, NOW)).resolves.toBeNull();
    await expect(h.auth.resolveAuthContext("", NOW)).resolves.toBeNull();
    await expect(
      h.auth.resolveAuthContext("not-a-real-token", NOW)
    ).resolves.toBeNull();
    // One character changed is enough: the hash no longer matches any session.
    await expect(
      h.auth.resolveAuthContext(`${token.slice(0, -1)}x`, NOW)
    ).resolves.toBeNull();
  });

  it("throws an authentication error when a protected path requires a session", async () => {
    const promise = h.auth.requireAuthContext(null, NOW);

    await expect(promise).rejects.toBeInstanceOf(AuthenticationError);
    await expect(promise).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("does not resolve an expired session and evicts it", async () => {
    const { token, session } = await loginFresh();
    const afterTtl = new Date(session.expiresAt.getTime() + 1);

    // Still good one millisecond before expiry.
    await expect(
      h.auth.resolveAuthContext(token, new Date(session.expiresAt.getTime() - 1))
    ).resolves.not.toBeNull();

    await expect(h.auth.resolveAuthContext(token, afterTtl)).resolves.toBeNull();
    // Evicted, so it cannot resolve again even at an earlier clock reading.
    await expect(h.auth.resolveAuthContext(token, NOW)).resolves.toBeNull();
  });

  it("invalidates the session on logout", async () => {
    const { token } = await loginFresh();
    await expect(h.auth.resolveAuthContext(token, NOW)).resolves.not.toBeNull();

    await h.auth.logout(token);

    await expect(h.auth.resolveAuthContext(token, NOW)).resolves.toBeNull();
    // Idempotent: logging out again (or with no token) is a no-op.
    await expect(h.auth.logout(token)).resolves.toBeUndefined();
    await expect(h.auth.logout(null)).resolves.toBeUndefined();
  });
});

describe("session cookie adapter", () => {
  it("serializes an HttpOnly, SameSite, site-wide cookie", async () => {
    const { token } = await loginFresh();

    const cookie = serializeSessionCookie(token, {
      maxAgeSeconds: DEFAULT_SESSION_TTL_MS / 1000,
      secure: true,
    });

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain(`Max-Age=${DEFAULT_SESSION_TTL_MS / 1000}`);
  });

  it("round-trips the token out of a Cookie header and resolves it", async () => {
    const { token, user } = await loginFresh();
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=${token}; locale=en-US`;

    const read = readSessionToken(header);

    expect(read).toBe(token);
    await expect(h.auth.resolveAuthContext(read, NOW)).resolves.toMatchObject({
      userId: user.id,
    });
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken("theme=dark")).toBeNull();
  });
});

/** Runs a login expected to fail and returns the thrown authentication error. */
async function captureLoginError(
  identifier: string,
  password: string
): Promise<AuthenticationError> {
  try {
    await h.auth.login({ identifier, password }, NOW);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthenticationError);
    return error as AuthenticationError;
  }
  throw new Error(`login unexpectedly succeeded for ${identifier}`);
}

/** Seeds a User and logs them in with valid credentials. */
async function loginFresh() {
  const { user } = await seedUser(h);
  const result = await h.auth.login(
    { identifier: PHONE, password: PASSWORD },
    NOW
  );
  return { ...result, user };
}
