import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryNotificationFailureLog,
  NotificationDispatcher,
  UnconfiguredEmailSender,
  hasEmailOnFile,
  newRfqMessage,
  recipientFromUser,
  type EmailSender,
  type Recipient,
  type SmsSender,
} from "./notifications";

const NOW = new Date("2025-03-01T09:00:00Z");

const MESSAGE = { subject: "subject", body: "body" };

/** Records every call; fails for the destinations named in `failFor`. */
class RecordingSmsSender implements SmsSender {
  readonly calls: Array<{ to: string; body: string }> = [];

  constructor(private readonly failFor: readonly string[] = []) {}

  async send(to: string, body: string): Promise<void> {
    this.calls.push({ to, body });
    if (this.failFor.includes(to)) throw new Error(`carrier rejected ${to}`);
  }
}

class RecordingEmailSender implements EmailSender {
  readonly calls: Array<{ to: string; subject: string; body: string }> = [];

  constructor(private readonly failFor: readonly string[] = []) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    this.calls.push({ to, subject, body });
    if (this.failFor.includes(to)) throw new Error(`relay rejected ${to}`);
  }
}

/** Throws synchronously, before ever returning a promise. */
class ThrowingSmsSender implements SmsSender {
  send(): Promise<void> {
    throw new Error("transport exploded synchronously");
  }
}

function recipient(overrides: Partial<Recipient> = {}): Recipient {
  return {
    userId: "usr-1",
    phone: "+16025550101",
    email: null,
    companyId: "co-1",
    ...overrides,
  };
}

describe("hasEmailOnFile", () => {
  it("treats null, undefined, and blank as no address", () => {
    expect(hasEmailOnFile(recipient({ email: null }))).toBe(false);
    expect(hasEmailOnFile(recipient({ email: undefined }))).toBe(false);
    expect(hasEmailOnFile(recipient({ email: "   " }))).toBe(false);
  });

  it("treats a real address as on file", () => {
    expect(hasEmailOnFile(recipient({ email: "dispatch@example.com" }))).toBe(true);
  });
});

describe("recipientFromUser", () => {
  it("carries the id, phone, email, and company", () => {
    expect(
      recipientFromUser({
        id: "usr-9",
        phone: "+16025550199",
        email: "d@example.com",
        companyId: "co-9",
      })
    ).toEqual({
      userId: "usr-9",
      phone: "+16025550199",
      email: "d@example.com",
      companyId: "co-9",
    });
  });
});

describe("newRfqMessage", () => {
  it("summarizes gallons, product, method, window, and a rough area", () => {
    const message = newRfqMessage({
      gallons: 500,
      productType: "ulsd",
      deliveryMethod: "wet_hose",
      deliveryWindow: "today",
      pinLat: 33.43531,
      pinLng: -112.35764,
    });

    expect(message.body).toContain("500 gal ULSD");
    expect(message.body).toContain("wet hose");
    expect(message.body).toContain("today");
    // Coarsened to two decimals, not the exact site pin.
    expect(message.body).toContain("33.44, -112.36");
    expect(message.body).not.toContain("33.43531");
    expect(message.subject).toContain("new RFQ");
  });

  it("stays inside a single SMS segment", () => {
    const message = newRfqMessage({
      gallons: 7500,
      productType: "dyed",
      deliveryMethod: "yard_tank",
      deliveryWindow: "tomorrow_am",
      pinLat: -33.123456,
      pinLng: -112.987654,
    });
    expect(message.body.length).toBeLessThanOrEqual(160);
  });
});

describe("NotificationDispatcher channel selection", () => {
  let sms: RecordingSmsSender;
  let email: RecordingEmailSender;
  let dispatcher: NotificationDispatcher;

  beforeEach(() => {
    sms = new RecordingSmsSender();
    email = new RecordingEmailSender();
    dispatcher = new NotificationDispatcher({ sms, email, clock: () => NOW });
  });

  it("sends SMS to every recipient", async () => {
    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [
        recipient({ userId: "a", phone: "+16025550101" }),
        recipient({ userId: "b", phone: "+16025550102" }),
      ],
      MESSAGE
    );

    expect(sms.calls.map((c) => c.to)).toEqual(["+16025550101", "+16025550102"]);
    expect(sms.calls[0].body).toBe(MESSAGE.body);
    expect(results).toEqual([
      { channel: "sms", recipientId: "a", ok: true },
      { channel: "sms", recipientId: "b", ok: true },
    ]);
  });

  it("adds email only for recipients with an address on file", async () => {
    await dispatcher.dispatch(
      "NEW_RFQ",
      [
        recipient({ userId: "a", phone: "+1602555011", email: null }),
        recipient({ userId: "b", phone: "+1602555012", email: "b@example.com" }),
        recipient({ userId: "c", phone: "+1602555013", email: "  " }),
      ],
      MESSAGE
    );

    expect(sms.calls).toHaveLength(3);
    expect(email.calls).toEqual([
      { to: "b@example.com", subject: MESSAGE.subject, body: MESSAGE.body },
    ]);
  });

  it("orders results per recipient with SMS before email", async () => {
    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [recipient({ userId: "a", email: "a@example.com" })],
      MESSAGE
    );
    expect(results.map((r) => r.channel)).toEqual(["sms", "email"]);
  });

  it("does nothing for an empty recipient list", async () => {
    await expect(dispatcher.dispatch("NEW_RFQ", [], MESSAGE)).resolves.toEqual([]);
    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
  });
});

describe("NotificationDispatcher failure isolation", () => {
  it("keeps going after a failed SMS and still attempts that recipient's email", async () => {
    const sms = new RecordingSmsSender(["+1602555012"]);
    const email = new RecordingEmailSender();
    const failures = new InMemoryNotificationFailureLog();
    const dispatcher = new NotificationDispatcher({
      sms,
      email,
      failureLog: failures,
      clock: () => NOW,
    });

    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [
        recipient({ userId: "a", phone: "+1602555011" }),
        recipient({ userId: "b", phone: "+1602555012", email: "b@example.com" }),
        recipient({ userId: "c", phone: "+1602555013" }),
      ],
      MESSAGE
    );

    expect(sms.calls).toHaveLength(3);
    expect(email.calls.map((c) => c.to)).toEqual(["b@example.com"]);
    expect(results).toEqual([
      { channel: "sms", recipientId: "a", ok: true },
      {
        channel: "sms",
        recipientId: "b",
        ok: false,
        error: "carrier rejected +1602555012",
      },
      { channel: "email", recipientId: "b", ok: true },
      { channel: "sms", recipientId: "c", ok: true },
    ]);

    expect(failures.list()).toEqual([
      {
        event: "NEW_RFQ",
        channel: "sms",
        recipientId: "b",
        destination: "+1602555012",
        error: "carrier rejected +1602555012",
        occurredAt: NOW,
      },
    ]);
  });

  it("isolates an email failure from the SMS that already succeeded", async () => {
    const sms = new RecordingSmsSender();
    const email = new RecordingEmailSender(["b@example.com"]);
    const dispatcher = new NotificationDispatcher({ sms, email, clock: () => NOW });

    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [recipient({ userId: "b", email: "b@example.com" })],
      MESSAGE
    );

    expect(results).toEqual([
      { channel: "sms", recipientId: "b", ok: true },
      {
        channel: "email",
        recipientId: "b",
        ok: false,
        error: "relay rejected b@example.com",
      },
    ]);
  });

  it("never throws when every delivery fails", async () => {
    const dispatcher = new NotificationDispatcher({
      sms: new ThrowingSmsSender(),
      email: new UnconfiguredEmailSender(),
      clock: () => NOW,
    });

    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [
        recipient({ userId: "a" }),
        recipient({ userId: "b", email: "b@example.com" }),
      ],
      MESSAGE
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results.map((r) => r.channel)).toEqual(["sms", "sms", "email"]);
  });

  it("records a failure rather than skipping a recipient with a blank phone", async () => {
    const sms = new RecordingSmsSender();
    const dispatcher = new NotificationDispatcher({ sms, clock: () => NOW });

    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [recipient({ userId: "a", phone: "" })],
      MESSAGE
    );

    expect(sms.calls).toHaveLength(0);
    expect(results).toEqual([
      {
        channel: "sms",
        recipientId: "a",
        ok: false,
        error: "No sms destination on file for this recipient",
      },
    ]);
  });

  it("survives a failure log that itself throws", async () => {
    const dispatcher = new NotificationDispatcher({
      sms: new ThrowingSmsSender(),
      failureLog: {
        record() {
          throw new Error("failure log is down too");
        },
      },
      clock: () => NOW,
    });

    await expect(
      dispatcher.dispatch("NEW_RFQ", [recipient()], MESSAGE)
    ).resolves.toMatchObject([{ channel: "sms", ok: false }]);
  });

  it("reports an unconfigured email transport as a per-channel failure", async () => {
    const dispatcher = new NotificationDispatcher({
      sms: new RecordingSmsSender(),
      clock: () => NOW,
    });

    const results = await dispatcher.dispatch(
      "NEW_RFQ",
      [recipient({ userId: "a", email: "a@example.com" })],
      MESSAGE
    );

    expect(results).toEqual([
      { channel: "sms", recipientId: "a", ok: true },
      {
        channel: "email",
        recipientId: "a",
        ok: false,
        error: "No email transport is configured",
      },
    ]);
  });
});
