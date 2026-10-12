/**
 * Notification dispatcher — SMS to everyone, email where an address is on file,
 * and nothing that can take down the caller.
 *
 * Requirements:
 *  13.1 a Request becoming visible to a matched Supplier Company sends that
 *       Supplier a new RFQ notification (wired in `RequestService`).
 *  13.5 every notification is sent via SMS to the recipient's phone number.
 *  13.6 where a recipient has an email address on file, the notification is
 *       also sent via email.
 *  13.7 a failed delivery attempt is recorded and processing of the remaining
 *       notifications continues.
 *
 * ## Shape
 *
 * Transports are injected ports (`SmsSender`, `EmailSender`) and the dispatcher
 * itself contains no vendor code: it decides channels, isolates failures, and
 * returns a result per attempt. The real Twilio and SMTP adapters live in
 * `src/infra/` and are deliberately thin, so the logic under test here is the
 * dispatcher's own — tests drive it with in-memory recording transports rather
 * than mocking the thing being tested.
 *
 * ## Failure isolation (Requirement 13.7)
 *
 * `dispatch` never throws because of a transport. Every attempt is wrapped
 * individually, so:
 *   - a recipient whose SMS fails still gets an email attempt;
 *   - a recipient whose email fails does not affect the next recipient;
 *   - a transport that throws synchronously, rejects, or hangs up on a bad
 *     number produces an `ok: false` result rather than an exception;
 *   - even a failing failure-log is swallowed — recording that we could not
 *     record must not become the thing that breaks the caller.
 *
 * Callers therefore treat notification as fire-and-forget: a dead Twilio
 * account never blocks a Request from being posted or an Order from advancing.
 */

import type {
  Delivery,
  DeliveryMethod,
  DeliveryWindow,
  Offer,
  ProductType,
  Request,
  User,
} from "@/domain/types";

// ---------------------------------------------------------------------------
// Events, recipients, results
// ---------------------------------------------------------------------------

export const NOTIFICATION_EVENTS = [
  "NEW_RFQ",
  "NEW_OFFER",
  "ACCEPTED",
  "DELIVERED",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_CHANNELS = ["sms", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * A notification target. Phone is required on `User`, so it is required here;
 * email is optional and its presence is exactly what decides the second channel
 * (Requirement 13.6).
 */
export interface Recipient {
  /** The `User.id`, echoed on every result so failures are attributable. */
  userId: string;
  phone: string;
  email?: string | null;
  /** Useful context when reading a failure log; not used for routing. */
  companyId?: string | null;
}

/** One delivery attempt on one channel for one recipient. */
export interface NotifyResult {
  channel: NotificationChannel;
  recipientId: string;
  ok: boolean;
  /** Present only when `ok` is false. */
  error?: string;
}

/** The rendered notification. `subject` is used by email only. */
export interface NotificationMessage {
  subject: string;
  body: string;
}

export interface NotificationFailure {
  event: NotificationEvent;
  channel: NotificationChannel;
  recipientId: string;
  /** The destination that failed, kept coarse to limit stored contact data. */
  destination: string;
  error: string;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface SmsSender {
  /** Resolves on hand-off to the carrier; rejects on any failure. */
  send(to: string, body: string): Promise<void>;
}

export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Where recorded failures go (Requirement 13.7). The design calls for a log
 * plus a `notification_failures` table; the table arrives with the Prisma
 * adapter, and this port is what it will implement. The default keeps failures
 * in memory and on the console so nothing is silently lost in the meantime.
 */
export interface NotificationFailureLog {
  record(failure: NotificationFailure): Promise<void> | void;
}

/** Retains failures in process and mirrors them to the console. */
export class InMemoryNotificationFailureLog implements NotificationFailureLog {
  private readonly failures: NotificationFailure[] = [];

  record(failure: NotificationFailure): void {
    this.failures.push({ ...failure });
    // eslint-disable-next-line no-console
    console.warn(
      `[notification] ${failure.event} ${failure.channel} to user ${failure.recipientId} failed: ${failure.error}`
    );
  }

  list(): NotificationFailure[] {
    return this.failures.map((failure) => ({ ...failure }));
  }

  clear(): void {
    this.failures.length = 0;
  }
}

/**
 * Stand-in for an unconfigured email transport. It rejects, which the
 * dispatcher records as an ordinary per-channel failure — so an operator who
 * has not set up email sees it in the failure log instead of silently losing
 * the "email where on file" behaviour.
 */
export class UnconfiguredEmailSender implements EmailSender {
  async send(): Promise<void> {
    throw new Error("No email transport is configured");
  }
}

// ---------------------------------------------------------------------------
// Message bodies
// ---------------------------------------------------------------------------

const PRODUCT_LABEL: Record<ProductType, string> = {
  ulsd: "ULSD",
  dyed: "dyed",
};

const METHOD_LABEL: Record<DeliveryMethod, string> = {
  wet_hose: "wet hose",
  yard_tank: "yard tank",
};

const WINDOW_LABEL: Record<DeliveryWindow, string> = {
  today: "today",
  tomorrow_am: "tomorrow AM",
};

/**
 * Coarsens a pin to ~1 km so a dispatcher can judge the haul without the
 * message carrying the exact yard location of a customer's site. Two decimals
 * of latitude/longitude is enough to place a load in a part of the valley.
 */
function roughArea(lat: number, lng: number): string {
  return `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
}

/**
 * The NEW_RFQ body (Requirement 13.1): gallons, product, delivery method,
 * window, and a rough area — what a dispatcher needs to decide whether to open
 * the app and quote.
 *
 * Deliberately omits the buyer company name, the contact, the notes, and the
 * exact pin. Those are one tap away in the app for a matched supplier; putting
 * them in an SMS would leak customer detail to every matched competitor and to
 * whatever carrier logs the message.
 */
export function newRfqMessage(
  request: Pick<
    Request,
    | "gallons"
    | "productType"
    | "deliveryMethod"
    | "deliveryWindow"
    | "pinLat"
    | "pinLng"
  >
): NotificationMessage {
  const summary = loadSummary(request);

  return {
    subject: `Load Energy: new RFQ (${summary})`,
    body:
      `Load Energy: new RFQ. ${summary}. ` +
      `Near ${roughArea(request.pinLat, request.pinLng)}. Quote it in the app.`,
  };
}

/**
 * Formats a landed price for a message. The column carries four decimals, but
 * trailing zeros in an SMS are noise, so it prints at the natural precision
 * with cents as the floor: `$3.45/gal`, `$3.4525/gal`.
 */
function formatUsdPerGal(pricePerGal: number): string {
  if (!Number.isFinite(pricePerGal)) return "$?/gal";
  const fixed = pricePerGal.toFixed(4).replace(/(\.\d{2}?\d*?)0+$/, "$1");
  return `$${fixed}/gal`;
}

/** `", ETA 45 min"` when an ETA was quoted, empty otherwise. */
function etaSuffix(etaMinutes: number | null | undefined): string {
  return typeof etaMinutes === "number" && Number.isFinite(etaMinutes)
    ? `, ETA ${etaMinutes} min`
    : "";
}

/** A one-line summary of the load itself, shared by several messages. */
function loadSummary(
  request: Pick<Request, "gallons" | "productType" | "deliveryMethod" | "deliveryWindow">
): string {
  return (
    `${request.gallons} gal ${PRODUCT_LABEL[request.productType]}, ` +
    `${METHOD_LABEL[request.deliveryMethod]}, ${WINDOW_LABEL[request.deliveryWindow]}`
  );
}

/**
 * The NEW_OFFER body (Requirement 13.2): the price, the hold, and the ETA —
 * what a superintendent needs to decide whether to open the app and accept.
 *
 * The hold is stated in hours rather than as an absolute expiry time so the
 * message carries no timezone to misread, and the quoting Supplier's name is
 * left out: the offer list in the app shows who quoted, and an SMS is the wrong
 * place to fan a competitor's identity out to anyone the phone is passed to.
 */
export function newOfferMessage(
  request: Pick<
    Request,
    "gallons" | "productType" | "deliveryMethod" | "deliveryWindow"
  >,
  offer: Pick<Offer, "landedPricePerGal" | "holdHours" | "etaMinutes">
): NotificationMessage {
  const quote =
    `${formatUsdPerGal(offer.landedPricePerGal)}${etaSuffix(offer.etaMinutes)}, ` +
    `${offer.holdHours}h hold`;

  return {
    subject: `Load Energy: new offer (${quote})`,
    body:
      `Load Energy: new offer on your ${loadSummary(request)}. ` +
      `${quote}. Accept it in the app before the hold runs out.`,
  };
}

/**
 * The ACCEPTED body (Requirement 13.3), sent to the winning Supplier: the load
 * they just won, the price they are committed to, and the rough area.
 *
 * The exact pin, the buyer company, and the site contact stay in the app. The
 * winner has a one-tap path to them there, and keeping them out of the SMS
 * means a forwarded message does not hand over a customer's yard.
 */
export function acceptedMessage(
  request: Pick<
    Request,
    | "gallons"
    | "productType"
    | "deliveryMethod"
    | "deliveryWindow"
    | "pinLat"
    | "pinLng"
  >,
  offer: Pick<Offer, "landedPricePerGal" | "etaMinutes">
): NotificationMessage {
  const summary = loadSummary(request);
  const quote = `${formatUsdPerGal(offer.landedPricePerGal)}${etaSuffix(offer.etaMinutes)}`;

  return {
    subject: `Load Energy: offer accepted (${summary})`,
    body:
      `Load Energy: your offer was accepted. ${summary} at ${quote}. ` +
      `Near ${roughArea(request.pinLat, request.pinLng)}. Open the app for delivery details.`,
  };
}

/**
 * The DELIVERED body (Requirement 13.4), sent to the owning Buyer: the gallons
 * that actually landed and the ticket number to match against the paperwork the
 * driver left on site.
 *
 * BOL gallons are the number that matters here — not the ordered gallons — so a
 * superintendent can spot a short load from the message without opening the app.
 * `request` is optional because a concierge Order (task 12.3) has no originating
 * Request to summarise.
 */
export function deliveredMessage(
  delivery: Pick<Delivery, "bolGallons" | "ticketNumber">,
  request?: Pick<
    Request,
    "gallons" | "productType" | "deliveryMethod" | "deliveryWindow"
  > | null
): NotificationMessage {
  // A concierge entry may carry no ticket number (Requirement 17.2); the line
  // is then simply omitted rather than reading "ticket null".
  const ticket = delivery.ticketNumber ? `, ticket ${delivery.ticketNumber}` : "";
  const landed = `${delivery.bolGallons} gal on the BOL${ticket}`;
  const ordered = request ? ` Ordered: ${loadSummary(request)}.` : "";

  return {
    subject: `Load Energy: delivered (${delivery.bolGallons} gal)`,
    body:
      `Load Energy: your fuel was delivered. ${landed}.${ordered} ` +
      `Open the app for the full ticket.`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Lifts a `User` into a notification `Recipient`. */
export function recipientFromUser(
  user: Pick<User, "id" | "phone" | "email" | "companyId">
): Recipient {
  return {
    userId: user.id,
    phone: user.phone,
    email: user.email,
    companyId: user.companyId,
  };
}

/** True when there is an email address on file to use (Requirement 13.6). */
export function hasEmailOnFile(recipient: Recipient): boolean {
  return typeof recipient?.email === "string" && recipient.email.trim() !== "";
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? error.name : error.message;
  }
  if (typeof error === "string" && error !== "") return error;
  return "Unknown notification transport failure";
}

export interface NotificationDispatcherDeps {
  sms: SmsSender;
  /** Defaults to the unconfigured stand-in, which records a failure per attempt. */
  email?: EmailSender;
  failureLog?: NotificationFailureLog;
  /** Injectable clock so failure timestamps stay deterministic in tests. */
  clock?: () => Date;
}

export class NotificationDispatcher {
  private readonly sms: SmsSender;
  private readonly email: EmailSender;
  private readonly failureLog: NotificationFailureLog;
  private readonly clock: () => Date;

  constructor(deps: NotificationDispatcherDeps) {
    this.sms = deps.sms;
    this.email = deps.email ?? new UnconfiguredEmailSender();
    this.failureLog = deps.failureLog ?? new InMemoryNotificationFailureLog();
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Sends `message` for `event` to every recipient: SMS always
   * (Requirement 13.5), email additionally where an address is on file
   * (Requirement 13.6).
   *
   * Returns one result per attempt, in recipient order with SMS before email.
   * Never throws (Requirement 13.7) — a failed attempt appears as an
   * `ok: false` result and is written to the failure log.
   *
   * Attempts run sequentially. For a pilot-sized matched-supplier set that is
   * both fast enough and easier to reason about: the result order is stable and
   * one slow carrier cannot fan out into dozens of concurrent sockets.
   */
  async dispatch(
    event: NotificationEvent,
    recipients: readonly Recipient[],
    message: NotificationMessage
  ): Promise<NotifyResult[]> {
    if (!Array.isArray(recipients) || recipients.length === 0) return [];

    const results: NotifyResult[] = [];

    for (const recipient of recipients) {
      // SMS is attempted for every recipient, even one with a blank phone: the
      // attempt is recorded as a failure rather than skipped, so a bad contact
      // record shows up in the log instead of vanishing.
      results.push(
        await this.attempt(event, "sms", recipient, recipient?.phone ?? "", () =>
          this.sms.send(recipient.phone, message.body)
        )
      );

      if (hasEmailOnFile(recipient)) {
        const address = (recipient.email as string).trim();
        results.push(
          await this.attempt(event, "email", recipient, address, () =>
            this.email.send(address, message.subject, message.body)
          )
        );
      }
    }

    return results;
  }

  /**
   * One isolated attempt. Catches synchronous throws and rejections alike (the
   * `send` call itself is inside the `try`, so a transport that throws before
   * returning a promise is handled too).
   */
  private async attempt(
    event: NotificationEvent,
    channel: NotificationChannel,
    recipient: Recipient,
    destination: string,
    send: () => Promise<void>
  ): Promise<NotifyResult> {
    const recipientId = recipient?.userId ?? "";
    try {
      if (destination.trim() === "") {
        throw new Error(`No ${channel} destination on file for this recipient`);
      }
      await send();
      return { channel, recipientId, ok: true };
    } catch (error) {
      const description = describeError(error);
      await this.recordFailure({
        event,
        channel,
        recipientId,
        destination,
        error: description,
        occurredAt: this.clock(),
      });
      return { channel, recipientId, ok: false, error: description };
    }
  }

  /** Recording a failure must never itself become a failure. */
  private async recordFailure(failure: NotificationFailure): Promise<void> {
    try {
      await this.failureLog.record(failure);
    } catch {
      // Intentionally swallowed: see the module note on failure isolation.
    }
  }
}
