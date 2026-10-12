/**
 * The shared `Repository` contract, plus the handful of guarantees that are
 * specific to the in-memory adapter (deterministic ids, `reset()`, and the
 * deliberate absence of foreign-key enforcement that lets the service-layer
 * property tests fabricate ids cheaply).
 *
 * Everything in the contract also runs against `PrismaRepository` — see
 * `prisma.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "./in-memory";
import {
  AT,
  buyerCompany,
  describeRepositoryContract,
  user,
} from "./repository-contract";
import type { NewOrder } from "@/domain/types";

describeRepositoryContract({
  label: "InMemoryRepository",
  create: () => new InMemoryRepository(),
});

describe("InMemoryRepository specifics", () => {
  it("assigns deterministic sequential ids so property-test failures replay", async () => {
    const repo = new InMemoryRepository();

    const first = await repo.createCompany(buyerCompany("First"));
    const second = await repo.createCompany(buyerCompany("Second"));

    expect(first.id).toBe("rec-1");
    expect(second.id).toBe("rec-2");
  });

  it("deep-clones on write so a later mutation of the input cannot leak in", async () => {
    const repo = new InMemoryRepository();
    const input = buyerCompany("Original");

    const created = await repo.createCompany(input);
    input.name = "Tampered";

    expect((await repo.getCompany(created.id))?.name).toBe("Original");
  });

  it("drops every record on reset", async () => {
    const repo = new InMemoryRepository();
    await repo.createCompany(buyerCompany("Acme Job Sites"));
    await repo.appendAuditEntry({
      actorUserId: null,
      action: "REQUEST_EXPIRED",
      subjectId: "request-1",
      payload: null,
      createdAt: AT,
    });

    repo.reset();

    expect(await repo.listCompanies()).toEqual([]);
    expect(await repo.countAuditEntries()).toBe(0);
    expect(await repo.getPilotGeofence()).toBeNull();
  });

  it("stores records whose references do not resolve, which the property tests rely on", async () => {
    const repo = new InMemoryRepository();

    // No company row exists for `company-1`; the in-memory adapter does not
    // enforce foreign keys, so the service-layer property tests can mint ids
    // without seeding a full object graph. Postgres rejects this, which is why
    // the shared contract seeds real parents.
    const seat = await repo.createUser(user("company-1", "+16025550100"));
    expect(seat.companyId).toBe("company-1");

    const dangling: NewOrder = {
      requestId: "request-1",
      offerId: "offer-1",
      buyerCompanyId: "buyer-1",
      supplierCompanyId: "supplier-1",
      status: "accepted",
      isConcierge: false,
      createdAt: AT,
    };
    const order = await repo.createOrder(dangling);
    expect(await repo.getOrderByRequest("request-1")).toEqual(order);
  });
});
