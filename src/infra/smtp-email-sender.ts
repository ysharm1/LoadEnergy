/**
 * SMTP email adapter — the production `EmailSender` (Requirement 13.6).
 *
 * As thin as the SMS adapter: build a transport from environment configuration,
 * send, let failures propagate to the dispatcher which isolates and records
 * them. Nothing here is exercised by tests; the dispatcher's channel-selection
 * and failure-isolation logic is tested with in-memory transports instead.
 *
 * SES-style by configuration rather than by SDK: Amazon SES, Postmark, Mailgun,
 * and a plain relay all expose an SMTP endpoint, so one adapter covers them and
 * the pilot avoids a cloud-provider SDK for a single sendmail call.
 *
 * Environment:
 *   SMTP_HOST        Relay host (e.g. email-smtp.us-west-2.amazonaws.com).
 *   SMTP_PORT        Optional, defaults to 587 (STARTTLS).
 *   SMTP_USER        SMTP username / SES SMTP credential. Optional for an
 *                    unauthenticated internal relay.
 *   SMTP_PASSWORD    SMTP password. Never logged.
 *   EMAIL_FROM       The From address, e.g. "Load Energy <alerts@...>".
 */

import nodemailer, { type Transporter } from "nodemailer";
import type { EmailSender } from "@/services/notifications";

export interface SmtpConfig {
  host: string;
  port: number;
  /** True for implicit TLS (port 465); false uses STARTTLS. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export const SMTP_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "EMAIL_FROM",
] as const;

export const DEFAULT_SMTP_PORT = 587;

function optionalEnv(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function requiredEnv(key: string): string {
  const value = optionalEnv(key);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

/** Reads SMTP configuration from the environment. Throws when incomplete. */
export function smtpConfigFromEnv(): SmtpConfig {
  const host = requiredEnv("SMTP_HOST");
  const from = requiredEnv("EMAIL_FROM");
  const rawPort = optionalEnv("SMTP_PORT");
  const port = rawPort === undefined ? DEFAULT_SMTP_PORT : Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("SMTP_PORT must be a valid TCP port number");
  }

  return {
    host,
    port,
    secure: port === 465,
    user: optionalEnv("SMTP_USER"),
    password: optionalEnv("SMTP_PASSWORD"),
    from,
  };
}

/**
 * True when the minimum email configuration is present. Email is optional in
 * the pilot (Requirement 13.6 applies only where an address is on file), so a
 * caller uses this to decide whether to wire an email transport at all.
 */
export function isSmtpConfigured(): boolean {
  return (
    optionalEnv("SMTP_HOST") !== undefined &&
    optionalEnv("EMAIL_FROM") !== undefined
  );
}

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpConfig, transporter?: Transporter) {
    this.from = config.from;
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth:
          config.user === undefined
            ? undefined
            : { user: config.user, pass: config.password ?? "" },
      });
  }

  /** Builds the adapter from `SMTP_*` / `EMAIL_FROM`; throws when incomplete. */
  static fromEnv(): SmtpEmailSender {
    return new SmtpEmailSender(smtpConfigFromEnv());
  }

  async send(to: string, subject: string, body: string): Promise<void> {
    // Plain text only: these are short operational alerts read on a phone, and
    // text keeps them out of the promotions tab and free of tracking markup.
    await this.transporter.sendMail({ from: this.from, to, subject, text: body });
  }
}
