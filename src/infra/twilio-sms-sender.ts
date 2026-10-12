/**
 * Twilio SMS adapter — the production `SmsSender` (Requirement 13.5).
 *
 * Deliberately thin: read credentials, hand the message to Twilio, let any
 * failure propagate. All the behaviour worth testing (which channels fire, how
 * failures are isolated) lives in `NotificationDispatcher`, which never sees
 * this file. Tests drive the dispatcher with in-memory transports, so no test
 * ever reaches the Twilio API.
 *
 * Environment:
 *   TWILIO_ACCOUNT_SID   Account SID (starts `AC`).
 *   TWILIO_AUTH_TOKEN    Auth token. Never logged.
 *   TWILIO_FROM_NUMBER   The sending number in E.164 form.
 *
 * Construction is lazy on purpose. `fromEnv` throws when configuration is
 * missing, but nothing calls it at import time, so a deployment without SMS
 * credentials fails on the first send attempt — which the dispatcher records as
 * an isolated failure (Requirement 13.7) — rather than crashing the server on
 * boot.
 */

import twilio, { type Twilio } from "twilio";
import type { SmsSender } from "@/services/notifications";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export const TWILIO_ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
] as const;

function requireEnv(key: (typeof TWILIO_ENV_KEYS)[number]): string {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim() === "") {
    // The message names the key, never the value — auth tokens stay out of logs.
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value.trim();
}

/** Reads Twilio configuration from the environment. Throws when incomplete. */
export function twilioConfigFromEnv(): TwilioConfig {
  return {
    accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
    authToken: requireEnv("TWILIO_AUTH_TOKEN"),
    fromNumber: requireEnv("TWILIO_FROM_NUMBER"),
  };
}

/** True when every Twilio variable is present — lets a caller pick a transport. */
export function isTwilioConfigured(): boolean {
  return TWILIO_ENV_KEYS.every((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

export class TwilioSmsSender implements SmsSender {
  private readonly client: Twilio;
  private readonly fromNumber: string;

  constructor(config: TwilioConfig, client?: Twilio) {
    this.fromNumber = config.fromNumber;
    this.client = client ?? twilio(config.accountSid, config.authToken);
  }

  /** Builds the adapter from `TWILIO_*`; throws when configuration is missing. */
  static fromEnv(): TwilioSmsSender {
    return new TwilioSmsSender(twilioConfigFromEnv());
  }

  async send(to: string, body: string): Promise<void> {
    await this.client.messages.create({ to, from: this.fromNumber, body });
  }
}
