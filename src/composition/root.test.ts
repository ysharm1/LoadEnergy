/**
 * Composition root — environment gating.
 *
 * The in-memory fallback is load-bearing for `next dev` and for this very
 * suite, so the only thing asserted here is where it stops: a production boot
 * with no `DATABASE_URL` must fail loudly rather than serve from a map and
 * forget the pilot's ledger on restart.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MISSING_DATABASE_URL_MESSAGE,
  createServicesFromEnv,
  resetServices,
} from "./root";
import { InMemoryRepository } from "@/repository/in-memory";
import { InMemorySessionStore } from "@/session/store";

afterEach(() => {
  vi.unstubAllEnvs();
  resetServices();
});

describe("createServicesFromEnv", () => {
  it("refuses to build a production graph without DATABASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", undefined);

    expect(() => createServicesFromEnv()).toThrow(/DATABASE_URL/);
    expect(() => createServicesFromEnv()).toThrow(
      MISSING_DATABASE_URL_MESSAGE
    );
  });

  it("names the variable and the fix, so the log is actionable", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", undefined);

    let message = "";
    try {
      createServicesFromEnv();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("Render");
  });

  it("treats a blank DATABASE_URL as absent in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "   ");

    expect(() => createServicesFromEnv()).toThrow(/DATABASE_URL/);
  });

  it("keeps the in-memory fallback outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", undefined);

    const services = createServicesFromEnv();

    expect(services.repo).toBeInstanceOf(InMemoryRepository);
    expect(services.sessions).toBeInstanceOf(InMemorySessionStore);
  });

  it("keeps the in-memory fallback under NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", undefined);

    const services = createServicesFromEnv();

    expect(services.repo).toBeInstanceOf(InMemoryRepository);
    expect(services.sessions).toBeInstanceOf(InMemorySessionStore);
  });
});
