/**
 * Property-based tests for the notification dispatcher and for the routing of
 * marketplace events to recipients.
 *
 * Feature: load-energy — Property 31 (task 9.7), Property 32 (task 5.8),
 * Property 33 (task 5.9).
 *
 * The dispatcher is the code under test; its SMS and email transports are
 * injected ports, so the tests supply in-memory recording / programmable
 * implementations of those ports. That is dependency injection, not mocking the
 * subject: no Twilio, no SMTP, and every channel decision, failure isolation,
 * and result shape comes from the real `NotificationDispatcher`.
 *
 * Property 31 widens the subject to the whole routing path: the real
 * `RequestService`, `OfferService`, and `OrderService` over the real
 * `InMemoryRepository`, with the real matching predicate deciding who sees an
 * RFQ, driving the real dispatcher over the same in-memory transports.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ROLES,
  type AuthContext,
  type Company,
  type Geofence,
  type Role,
} from "@/domain/types";
import { InMemoryRepository } from "@/repository/in-memory";
import { AdminService } from "./admin";
import { MatchingService } from "./matching";
import { OfferService } from "./offer";
import { OrderService } from "./order";
import { RequestService } from "./request";
import {
  NOTIFICATION_EVENTS,
  NotificationDispatcher,
  type EmailSender,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationFailure,
  type NotificationFailureLog,
  type NotificationMessage,
  type NotifyResult,
  type Recipient,
  type SmsSender,
} from "./notifications";

const FAILED_AT = new Date("2025-03-01T09:00:00Z");

const MESSAGE = {
  subject: "Load Energy: new RFQ (500 gal ULSD)",
  body: "Load Energy: new RFQ. 500 gal ULSD, wet hose, today.",
};

const notificationEvent: fc.Arbitrary<NotificationEvent> = fc.constantFrom(
  ...NOTIFICATION_EVENTS
);

// ---------------------------------------------------------------------------
// Transport ports and the failure log, in memory
// ---------------------------------------------------------------------------

/** How a transport behaves for one destination. */
type TransportMode = "ok" | "reject" | "throw";

/**
 * Records every call and behaves per destination. `send` is deliberately NOT
 * declared `async`, so `throw` is a genuine synchronous throw before any
 * promise exists — the case the dispatcher documents it also handles.
 */
class ProgrammableSmsSender implements SmsSender {
  readonly calls: Array<{ to: string; body: string }> = [];

  constructor(private readonly modes: Map<string, TransportMode> = new Map()) {}

  send(to: string, body: string): Promise<void> {
    this.calls.push({ to, body });
    const mode = this.modes.get(to) ?? "ok";
    if (mode === "throw") throw new Error(`sms transport threw for ${to}`);
    if (mode === "reject") {
      return Promise.reject(new Error(`carrier rejected ${to}`));
    }
    return Promise.resolve();
  }
}

class ProgrammableEmailSender implements EmailSender {
  readonly calls: Array<{ to: string; subject: string; body: string }> = [];

  constructor(private readonly modes: Map<string, TransportMode> = new Map()) {}

  send(to: string, subject: string, body: string): Promise<void> {
    this.calls.push({ to, subject, body });
    const mode = this.modes.get(to) ?? "ok";
    if (mode === "throw") throw new Error(`email transport threw for ${to}`);
    if (mode === "reject") {
      return Promise.reject(new Error(`relay rejected ${to}`));
    }
    return Promise.resolve();
  }
}

/** Collects recorded failures (the production port writes them to a table). */
class RecordingFailureLog implements NotificationFailureLog {
  readonly failures: NotificationFailure[] = [];

  record(failure: NotificationFailure): void {
    this.failures.push({ ...failure });
  }
}

// ---------------------------------------------------------------------------
// Recipient generators — email present, absent, null, blank, and padded
// ---------------------------------------------------------------------------

type EmailKind = "present" | "absent" | "null" | "blank" | "padded";

const emailKind: fc.Arbitrary<EmailKind> = fc.constantFrom(
  "present",
  "absent",
  "null",
  "blank",
  "padded"
);

/** Whitespace-only strings, which are not an address on file. */
const blankEmail = fc.constantFrom("", " ", "   ", "\t", "\n", " \t \n ");

interface RecipientSpec {
  emailKind: EmailKind;
  blank: string;
  smsMode: TransportMode;
  emailMode: TransportMode;
}

const recipientSpec: fc.Arbitrary<RecipientSpec> = fc.record({
  emailKind,
  blank: blankEmail,
  smsMode: fc.constantFrom<TransportMode>("ok", "reject", "throw"),
  emailMode: fc.constantFrom<TransportMode>("ok", "reject", "throw"),
});

const recipientSpecs = fc.array(recipientSpec, { minLength: 1, maxLength: 6 });

interface ResolvedRecipient {
  recipient: Recipient;
  spec: RecipientSpec;
  /** The trimmed address the dispatcher should use, or null when none is on file. */
  emailDestination: string | null;
}

/**
 * Turns a spec into a `Recipient`. Phones and addresses are unique per index so
 * a per-destination transport mode targets exactly one attempt.
 */
function resolveRecipient(
  spec: RecipientSpec,
  index: number
): ResolvedRecipient {
  const address = `dispatcher${index}@example.com`;

  let email: string | null | undefined;
  switch (spec.emailKind) {
    case "present":
      email = address;
      break;
    case "padded":
      email = `  ${address}  `;
      break;
    case "absent":
      email = undefined;
      break;
    case "null":
      email = null;
      break;
    default:
      email = spec.blank;
  }

  const onFile = spec.emailKind === "present" || spec.emailKind === "padded";

  return {
    spec,
    emailDestination: onFile ? address : null,
    recipient: {
      userId: `usr-${index}`,
      phone: `+1602555${String(index + 1).padStart(4, "0")}`,
      email,
      companyId: `co-${index}`,
    },
  };
}

interface Attempt {
  channel: NotificationChannel;
  recipientId: string;
  destination: string;
  ok: boolean;
}

/**
 * The attempts the dispatcher owes us, derived from the raw recipient data:
 * SMS for every recipient (Requirement 13.5), email additionally exactly where
 * a non-blank address is on file (Requirement 13.6), in recipient order with
 * SMS first.
 */
function expectedAttempts(
  resolved: readonly ResolvedRecipient[],
  /** Mirrors `makeDispatcher`: when false the transports all succeed. */
  honourFailureModes: boolean
): Attempt[] {
  const attempts: Attempt[] = [];
  for (const entry of resolved) {
    attempts.push({
      channel: "sms",
      recipientId: entry.recipient.userId,
      destination: entry.recipient.phone,
      ok: !honourFailureModes || entry.spec.smsMode === "ok",
    });
    if (entry.emailDestination !== null) {
      attempts.push({
        channel: "email",
        recipientId: entry.recipient.userId,
        destination: entry.emailDestination,
        ok: !honourFailureModes || entry.spec.emailMode === "ok",
      });
    }
  }
  return attempts;
}

function makeDispatcher(
  resolved: readonly ResolvedRecipient[],
  /** When false, every transport succeeds regardless of the generated modes. */
  honourFailureModes: boolean
) {
  const smsModes = new Map<string, TransportMode>();
  const emailModes = new Map<string, TransportMode>();

  if (honourFailureModes) {
    for (const entry of resolved) {
      smsModes.set(entry.recipient.phone, entry.spec.smsMode);
      if (entry.emailDestination !== null) {
        emailModes.set(entry.emailDestination, entry.spec.emailMode);
      }
    }
  }

  const sms = new ProgrammableSmsSender(smsModes);
  const email = new ProgrammableEmailSender(emailModes);
  const failureLog = new RecordingFailureLog();

  return {
    sms,
    email,
    failureLog,
    dispatcher: new NotificationDispatcher({
      sms,
      email,
      failureLog,
      clock: () => FAILED_AT,
    }),
  };
}

// ---------------------------------------------------------------------------
// Property 32 (task 5.8)
// ---------------------------------------------------------------------------

describe("Property 32: Notification channel selection", () => {
  // Feature: load-energy, Property 32: Notification channel selection
  // **Validates: Requirements 13.5, 13.6**
  it("always attempts SMS, and attempts email exactly when an address is on file", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ event: notificationEvent, specs: recipientSpecs }),
        async ({ event, specs }) => {
          const resolved = specs.map(resolveRecipient);
          // Channel selection is the subject here, so every transport succeeds:
          // failure behaviour is Property 33's job.
          const { dispatcher, sms, email } = makeDispatcher(resolved, false);

          const results = await dispatcher.dispatch(
            event,
            resolved.map((entry) => entry.recipient),
            MESSAGE
          );

          const expected = expectedAttempts(resolved, false);

          // One result per attempt, in recipient order with SMS before email.
          expect(
            results.map((result) => ({
              channel: result.channel,
              recipientId: result.recipientId,
              ok: result.ok,
            }))
          ).toEqual(
            expected.map((attempt) => ({
              channel: attempt.channel,
              recipientId: attempt.recipientId,
              ok: attempt.ok,
            }))
          );

          // Requirement 13.5: an SMS attempt reaches the transport for every
          // recipient, carrying the message body, in order.
          expect(sms.calls).toEqual(
            resolved.map((entry) => ({
              to: entry.recipient.phone,
              body: MESSAGE.body,
            }))
          );
          expect(
            results.filter((result) => result.channel === "sms").length
          ).toBe(resolved.length);

          // Requirement 13.6: an email attempt reaches the transport if and
          // only if the recipient has a non-blank address on file, trimmed, and
          // carries the subject as well as the body.
          expect(email.calls).toEqual(
            resolved
              .filter((entry) => entry.emailDestination !== null)
              .map((entry) => ({
                to: entry.emailDestination as string,
                subject: MESSAGE.subject,
                body: MESSAGE.body,
              }))
          );

          const emailedIds = results
            .filter((result) => result.channel === "email")
            .map((result) => result.recipientId);
          expect(emailedIds).toEqual(
            resolved
              .filter((entry) => entry.emailDestination !== null)
              .map((entry) => entry.recipient.userId)
          );

          // The biconditional, stated per recipient: an email attempt exists
          // exactly when the recipient has an address on file — absent, null,
          // and whitespace-only all mean no attempt.
          for (const entry of resolved) {
            const onFile = entry.emailDestination !== null;
            expect(
              emailedIds.includes(entry.recipient.userId),
              `emailKind=${entry.spec.emailKind}`
            ).toBe(onFile);
            expect(
              email.calls.some((call) => call.to === entry.emailDestination)
            ).toBe(onFile);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 33 (task 5.9)
// ---------------------------------------------------------------------------

describe("Property 33: Notification dispatch is resilient", () => {
  // Feature: load-energy, Property 33: Notification dispatch is resilient
  // **Validates: Requirements 13.7**
  it("attempts every recipient, records every failure, and never raises", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ event: notificationEvent, specs: recipientSpecs }),
        async ({ event, specs }) => {
          const resolved = specs.map(resolveRecipient);
          const { dispatcher, sms, email, failureLog } = makeDispatcher(
            resolved,
            true
          );

          // Requirement 13.7: dispatch does not raise, whatever the transports
          // do — synchronous throws and rejections alike.
          let thrown: unknown;
          let results: Awaited<ReturnType<typeof dispatcher.dispatch>> = [];
          try {
            results = await dispatcher.dispatch(
              event,
              resolved.map((entry) => entry.recipient),
              MESSAGE
            );
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeUndefined();

          const expected = expectedAttempts(resolved, true);

          // Every recipient is attempted and every attempt is reported, with
          // ok/failed matching what its transport did.
          expect(results.length).toBe(expected.length);
          results.forEach((result, index) => {
            const attempt = expected[index];
            expect(result.channel).toBe(attempt.channel);
            expect(result.recipientId).toBe(attempt.recipientId);
            expect(
              result.ok,
              `${attempt.channel} for ${attempt.recipientId}`
            ).toBe(attempt.ok);
            if (attempt.ok) {
              expect(result.error).toBeUndefined();
            } else {
              expect(typeof result.error).toBe("string");
              expect(result.error).not.toBe("");
            }
          });

          // Processing continued: the transport saw a call for every attempt,
          // including the ones after a failure.
          expect(sms.calls.map((call) => call.to)).toEqual(
            resolved.map((entry) => entry.recipient.phone)
          );
          expect(email.calls.map((call) => call.to)).toEqual(
            resolved
              .filter((entry) => entry.emailDestination !== null)
              .map((entry) => entry.emailDestination as string)
          );

          // Requirement 13.7: each failure is recorded, once, with the event,
          // channel, recipient, destination, message, and timestamp.
          const failedAttempts = expected.filter((attempt) => !attempt.ok);
          expect(failureLog.failures.length).toBe(failedAttempts.length);

          const failedResults = results.filter((result) => !result.ok);
          failedResults.forEach((result, index) => {
            const attempt = failedAttempts[index];
            expect(failureLog.failures[index]).toEqual({
              event,
              channel: attempt.channel,
              recipientId: attempt.recipientId,
              destination: attempt.destination,
              error: result.error,
              occurredAt: FAILED_AT,
            });
          });

          // Nothing is recorded for an attempt that succeeded.
          const succeeded = results.filter((result) => result.ok);
          for (const result of succeeded) {
            expect(
              failureLog.failures.some(
                (failure) =>
                  failure.recipientId === result.recipientId &&
                  failure.channel === result.channel
              )
            ).toBe(false);
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Property 31 (task 9.7) — event-to-recipient routing, end to end
// ---------------------------------------------------------------------------

/**
 * Everything on this path is real: `RequestService` (which matches suppliers
 * through the real matching predicate and fires NEW_RFQ), `OfferService`
 * (NEW_OFFER), `OrderService` (ACCEPTED and DELIVERED), the real
 * `NotificationDispatcher`, and the real `InMemoryRepository` enforcing the same
 * unique constraints as the Prisma schema. Only the two transports are in-memory
 * recorders, which is how the test can see who was actually paged.
 */

const ROUTED_AT = new Date("2025-03-01T09:00:00Z");

const SW_VALLEY: Geofence = {
  minLat: 33.2,
  maxLat: 33.6,
  minLng: -112.7,
  maxLng: -112.1,
};

/** The load's pin, inside the fence. */
const GOODYEAR = { lat: 33.4353, lng: -112.3576 };
/** ~13 mi from the pin: inside a 50 mi radius. */
const BUCKEYE = { lat: 33.3703, lng: -112.5838 };
/** ~110 mi from the pin: outside it, so eligibility is decided by the spec. */
const TUCSON = { lat: 32.2226, lng: -110.9747 };
const SERVICE_RADIUS_MILES = 50;

const LOAD = {
  gallons: 500,
  productType: "ulsd",
  deliveryMethod: "wet_hose",
  deliveryWindow: "today",
  ...GOODYEAR,
} as const;

/**
 * Records which event went to which recipients while still running the real
 * dispatch. Subclassing rather than substituting keeps the channel selection,
 * failure isolation, and transport calls entirely the production dispatcher's.
 */
class RoutingDispatcher extends NotificationDispatcher {
  readonly dispatches: Array<{
    event: NotificationEvent;
    recipientIds: string[];
  }> = [];

  async dispatch(
    event: NotificationEvent,
    recipients: readonly Recipient[],
    message: NotificationMessage
  ): Promise<NotifyResult[]> {
    this.dispatches.push({
      event,
      recipientIds: recipients.map((recipient) => recipient.userId),
    });
    return super.dispatch(event, recipients, message);
  }
}

// ---------------------------------------------------------------------------
// Marketplace generators
// ---------------------------------------------------------------------------

/**
 * How a Supplier Company is configured. Radius membership is controlled by
 * placing the company's Operating_Location at a near or far origin, so the
 * expected recipient set below is read straight off the generated spec and
 * never recomputed with the matching predicate under test.
 */
type SupplierEligibility =
  | "approved_open"
  | "approved_limited"
  | "pending"
  | "closed"
  | "out_of_radius";

const SUPPLIER_ELIGIBILITIES: readonly SupplierEligibility[] = [
  "approved_open",
  "approved_limited",
  "pending",
  "closed",
  "out_of_radius",
];

/** A seat on a company: any of the three roles, with or without an email. */
interface SeatSpec {
  role: Role;
  hasEmail: boolean;
}

const seatSpec: fc.Arbitrary<SeatSpec> = fc.record({
  role: fc.constantFrom(...ROLES),
  hasEmail: fc.boolean(),
});

interface SupplierCompanySpec {
  eligibility: SupplierEligibility;
  seats: SeatSpec[];
}

const supplierCompanySpec: fc.Arbitrary<SupplierCompanySpec> = fc.record({
  eligibility: fc.constantFrom(...SUPPLIER_ELIGIBILITIES),
  seats: fc.array(seatSpec, { maxLength: 3 }),
});

/**
 * One marketplace. The first Supplier Company is forced matchable and given a
 * dispatcher seat so there is always a quote to accept and a win to deliver;
 * every other company, seat, and role mix is free.
 */
const marketplaceSpec = fc.record({
  firstSupplier: fc.record({
    eligibility: fc.constantFrom<SupplierEligibility>(
      "approved_open",
      "approved_limited"
    ),
    seats: fc.array(seatSpec, { maxLength: 2 }),
  }),
  otherSuppliers: fc.array(supplierCompanySpec, { maxLength: 3 }),
  /** Extra seats on the owning Buyer Company, beyond its guaranteed buyer. */
  buyerSeats: fc.array(seatSpec, { maxLength: 2 }),
  /** A second Buyer Company that is party to nothing and must never be paged. */
  otherBuyerSeats: fc.array(seatSpec, { minLength: 1, maxLength: 2 }),
  /** Which quote wins, taken modulo the number of quotes submitted. */
  winnerIndex: fc.nat({ max: 7 }),
  /** Whether the winner taps En_Route before recording the BOL. */
  markEnRoute: fc.boolean(),
});

type MarketplaceSpec = typeof marketplaceSpec extends fc.Arbitrary<infer T>
  ? T
  : never;

// ---------------------------------------------------------------------------
// Marketplace construction
// ---------------------------------------------------------------------------

interface Seat {
  id: string;
  phone: string;
  email: string | null;
  role: Role;
  ctx: AuthContext;
}

interface SupplierCompanyUnderTest {
  company: Company;
  /** Read off the spec: Approved, Open|Limited, and in radius. */
  matched: boolean;
  seats: Seat[];
}

interface Marketplace {
  requests: RequestService;
  offers: OfferService;
  orders: OrderService;
  dispatcher: RoutingDispatcher;
  sms: ProgrammableSmsSender;
  email: ProgrammableEmailSender;
  /** Every seat in the world, used to assert that non-recipients are silent. */
  seats: Seat[];
  seatByPhone: Map<string, Seat>;
  buyerCtx: AuthContext;
  /** Buyer-role seats of the owning Buyer Company. */
  owningBuyerSeatIds: string[];
  suppliers: SupplierCompanyUnderTest[];
}

function buyerCompanyInput(name: string) {
  return {
    name,
    kind: "buyer" as const,
    supplierApprovalStatus: null,
    supplierStatus: null,
    operatingLat: null,
    operatingLng: null,
    serviceRadiusMiles: null,
    createdAt: ROUTED_AT,
  };
}

async function buildMarketplace(spec: MarketplaceSpec): Promise<Marketplace> {
  const repo = new InMemoryRepository();
  const sms = new ProgrammableSmsSender();
  const email = new ProgrammableEmailSender();
  const dispatcher = new RoutingDispatcher({
    sms,
    email,
    failureLog: new RecordingFailureLog(),
    clock: () => ROUTED_AT,
  });

  const admin = new AdminService({ repo });
  const matching = new MatchingService({ repo });
  const requests = new RequestService({
    repo,
    admin,
    matching,
    notifier: dispatcher,
  });
  const offers = new OfferService({ repo, notifier: dispatcher });
  const orders = new OrderService({ repo, notifier: dispatcher });

  const seats: Seat[] = [];
  let nextSeat = 0;

  const addSeat = async (
    companyId: string,
    seatSpecification: SeatSpec
  ): Promise<Seat> => {
    const index = nextSeat++;
    const user = await repo.createUser({
      companyId,
      role: seatSpecification.role,
      // Unique per seat, so a recorded SMS maps back to exactly one seat.
      phone: `+1602555${String(1000 + index).padStart(4, "0")}`,
      email: seatSpecification.hasEmail ? `seat${index}@example.com` : null,
      passwordHash: "hash",
      createdAt: ROUTED_AT,
    });
    const seat: Seat = {
      id: user.id,
      phone: user.phone,
      email: user.email,
      role: user.role,
      ctx: { userId: user.id, companyId, role: user.role },
    };
    seats.push(seat);
    return seat;
  };

  const operatorCo = await repo.createCompany(buyerCompanyInput("Load Energy"));
  const buyerCo = await repo.createCompany(
    buyerCompanyInput("SW Valley Concrete")
  );
  const otherBuyerCo = await repo.createCompany(
    buyerCompanyInput("Rival Paving")
  );

  // The operator's Admin seat configures the pilot box and is party to nothing,
  // so it is one more seat that must stay silent on every event.
  const operator = await addSeat(operatorCo.id, {
    role: "admin",
    hasEmail: true,
  });
  await repo.setPilotGeofence({
    ...SW_VALLEY,
    setByAdminId: operator.id,
    updatedAt: ROUTED_AT,
  });

  const owningBuyerSeats: Seat[] = [];
  for (const seat of [
    { role: "buyer" as Role, hasEmail: true },
    ...spec.buyerSeats,
  ]) {
    owningBuyerSeats.push(await addSeat(buyerCo.id, seat));
  }
  for (const seat of spec.otherBuyerSeats) {
    await addSeat(otherBuyerCo.id, seat);
  }

  const supplierSpecs: SupplierCompanySpec[] = [
    {
      eligibility: spec.firstSupplier.eligibility,
      seats: [
        { role: "supplier", hasEmail: true },
        ...spec.firstSupplier.seats,
      ],
    },
    ...spec.otherSuppliers,
  ];

  const suppliers: SupplierCompanyUnderTest[] = [];
  for (const [index, supplierSpec] of supplierSpecs.entries()) {
    const origin =
      supplierSpec.eligibility === "out_of_radius" ? TUCSON : BUCKEYE;
    const company = await repo.createCompany({
      name: `Supplier ${index} Diesel`,
      kind: "supplier",
      supplierApprovalStatus:
        supplierSpec.eligibility === "pending" ? "pending" : "approved",
      supplierStatus:
        supplierSpec.eligibility === "closed"
          ? "closed"
          : supplierSpec.eligibility === "approved_limited"
            ? "limited"
            : "open",
      operatingLat: origin.lat,
      operatingLng: origin.lng,
      serviceRadiusMiles: SERVICE_RADIUS_MILES,
      createdAt: ROUTED_AT,
    });

    const companySeats: Seat[] = [];
    for (const seat of supplierSpec.seats) {
      companySeats.push(await addSeat(company.id, seat));
    }

    suppliers.push({
      company,
      matched:
        supplierSpec.eligibility === "approved_open" ||
        supplierSpec.eligibility === "approved_limited",
      seats: companySeats,
    });
  }

  return {
    requests,
    offers,
    orders,
    dispatcher,
    sms,
    email,
    seats,
    seatByPhone: new Map(seats.map((seat) => [seat.phone, seat])),
    buyerCtx: owningBuyerSeats[0].ctx,
    owningBuyerSeatIds: owningBuyerSeats
      .filter((seat) => seat.role === "buyer")
      .map((seat) => seat.id),
    suppliers,
  };
}

/** The supplier-role seats of a Supplier Company — the dispatchers who get paged. */
function dispatcherSeatIds(supplier: SupplierCompanyUnderTest): string[] {
  return supplier.seats
    .filter((seat) => seat.role === "supplier")
    .map((seat) => seat.id);
}

function sorted(ids: readonly (string | undefined)[]): string[] {
  return [...ids].map((id) => id ?? "unknown-seat").sort();
}

/**
 * Runs one lifecycle step and asserts who it notified.
 *
 * `event` is the event the step owes (or null when it owes none), and
 * `expectedIds` the seats that must be paged. Both directions are checked: the
 * expected seats were reached through the real transport, and no other seat in
 * the world was touched on either channel.
 */
async function observe<T>(
  market: Marketplace,
  event: NotificationEvent | null,
  expectedIds: readonly string[],
  step: () => Promise<T>
): Promise<T> {
  const dispatchMark = market.dispatcher.dispatches.length;
  const smsMark = market.sms.calls.length;
  const emailMark = market.email.calls.length;

  const result = await step();

  const dispatches = market.dispatcher.dispatches.slice(dispatchMark);
  const smsCalls = market.sms.calls.slice(smsMark);
  const emailCalls = market.email.calls.slice(emailMark);

  if (event === null) {
    expect(dispatches).toEqual([]);
  } else {
    for (const dispatch of dispatches) {
      expect(dispatch.event).toBe(event);
    }
  }

  // The event was addressed to exactly the right seats.
  expect(sorted(dispatches.flatMap((dispatch) => dispatch.recipientIds))).toEqual(
    sorted(expectedIds)
  );

  // And it reached them: one SMS per expected seat, nothing extra.
  expect(
    sorted(smsCalls.map((call) => market.seatByPhone.get(call.to)?.id))
  ).toEqual(sorted(expectedIds));

  // Nobody else in the marketplace was paged on either channel.
  const expected = new Set(expectedIds);
  for (const seat of market.seats) {
    if (expected.has(seat.id)) continue;
    expect(
      smsCalls.some((call) => call.to === seat.phone),
      `${seat.role} seat ${seat.id} must not be texted`
    ).toBe(false);
    if (seat.email !== null) {
      expect(
        emailCalls.some((call) => call.to === seat.email),
        `${seat.role} seat ${seat.id} must not be emailed`
      ).toBe(false);
    }
  }

  return result;
}

describe("Property 31: Marketplace events notify the correct recipients", () => {
  // Feature: load-energy, Property 31: Marketplace events notify the correct recipients
  // **Validates: Requirements 13.1, 13.2, 13.3, 13.4**
  it("routes NEW_RFQ, NEW_OFFER, ACCEPTED, and DELIVERED to exactly the right seats", async () => {
    await fc.assert(
      fc.asyncProperty(marketplaceSpec, async (spec) => {
        const market = await buildMarketplace(spec);

        // Requirement 13.1 — every matched Supplier Company's dispatcher seats,
        // and only those: no Pending, Closed, or out-of-radius company, and no
        // buyer/admin seat sitting on a matched company.
        const matched = market.suppliers.filter(
          (supplier) => supplier.matched
        );
        const request = await observe(
          market,
          "NEW_RFQ",
          matched.flatMap(dispatcherSeatIds),
          () => market.requests.createRequest(market.buyerCtx, LOAD, ROUTED_AT)
        );

        // Requirement 13.2 — the owning Buyer Company's buyer seats, once per
        // quote. The quoting supplier is never paged for its own offer.
        const quoters = matched.filter((supplier) =>
          supplier.seats.some((seat) => seat.role === "supplier")
        );
        const quotes: Array<{
          offerId: string;
          supplier: SupplierCompanyUnderTest;
          seatCtx: AuthContext;
        }> = [];

        for (const [index, supplier] of quoters.entries()) {
          const seatCtx = supplier.seats.find(
            (seat) => seat.role === "supplier"
          )!.ctx;
          const offer = await observe(
            market,
            "NEW_OFFER",
            market.owningBuyerSeatIds,
            () =>
              market.offers.createOffer(
                seatCtx,
                {
                  requestId: request.id,
                  landedPricePerGal: 3.5 + index * 0.05,
                  holdHours: 4,
                },
                ROUTED_AT
              )
          );
          quotes.push({ offerId: offer.id, supplier, seatCtx });
        }

        // Requirement 13.3 — the winning Supplier only. Losing suppliers, whose
        // quotes are voided by the same acceptance, are not paged.
        const winner = quotes[spec.winnerIndex % quotes.length];
        const order = await observe(
          market,
          "ACCEPTED",
          dispatcherSeatIds(winner.supplier),
          () => market.orders.acceptOffer(market.buyerCtx, winner.offerId, ROUTED_AT)
        );

        // En_Route is not one of the four events: it pages nobody.
        if (spec.markEnRoute) {
          await observe(market, null, [], () =>
            market.orders.advanceStatus(winner.seatCtx, order.id, "en_route")
          );
        }

        // Requirement 13.4 — reaching Delivered pages the owning Buyer, not the
        // supplier who recorded the BOL.
        await observe(market, "DELIVERED", market.owningBuyerSeatIds, () =>
          market.orders.recordDelivery(
            winner.seatCtx,
            order.id,
            { bolGallons: 480, ticketNumber: "BOL-77421" },
            ROUTED_AT
          )
        );
      })
    );
  });
});
