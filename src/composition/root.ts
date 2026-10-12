/**
 * Composition root — the one place the service layer is wired together.
 *
 * Services depend on ports and on each other through constructor injection and
 * never reach for a singleton, which is what makes them property-testable. The
 * cost of that is a graph somebody has to assemble; this module is that
 * somebody, and it is the only module in the codebase that knows both a
 * service and a concrete adapter.
 *
 * ## The Request <-> Matching cycle
 *
 * `RequestService` needs `MatchingService` (to decide who gets the NEW_RFQ),
 * and `MatchingService` needs `RequestService.expireIfWindowEnded` (to record
 * lazy window-end expiry as it reads). The knot is tied with a thunk, exactly
 * as documented at the top of `src/services/matching.ts`: matching holds a
 * closure that calls whatever `requests` ends up being, so neither service
 * holds a half-built reference and neither needs a mutable field.
 *
 * ## Transports degrade, they do not crash
 *
 * Adapters are built only when their environment is configured, and a missing
 * transport becomes a stand-in that rejects. The dispatcher records that as an
 * ordinary per-channel failure (Requirement 13.7), so a pilot deployment
 * without Twilio or S3 still takes orders — it just logs that it could not
 * page anyone, which is the behaviour the design asks for.
 *
 * ## Persistence does not degrade
 *
 * The one exception to that rule is the database. `createServicesFromEnv`
 * picks the in-memory repository and session store when `DATABASE_URL` is
 * unset, which is what makes `next dev` and the test suite work with nothing
 * installed — but when `NODE_ENV === "production"` the same gap throws
 * `MISSING_DATABASE_URL_MESSAGE` instead. A transport that cannot deliver
 * loses a notification; a repository that forgets loses the ledger, so the
 * only safe production behaviour is to refuse to start.
 */

import { InMemoryRepository } from "@/repository/in-memory";
import { PrismaRepository } from "@/repository/prisma";
import {
  getPrismaClient,
  isDatabaseConfigured,
} from "@/repository/prisma-client";
import type { Repository } from "@/repository/repository";
import { PrismaSessionStore } from "@/session/prisma-store";
import { InMemorySessionStore, type SessionStore } from "@/session/store";
import {
  isS3TicketPhotoConfigured,
  S3TicketPhotoStorage,
} from "@/infra/s3-ticket-photo-storage";
import { isSmtpConfigured, SmtpEmailSender } from "@/infra/smtp-email-sender";
import { isTwilioConfigured, TwilioSmsSender } from "@/infra/twilio-sms-sender";
import { AdminService } from "@/services/admin";
import { AuditService } from "@/services/audit";
import { AuthService } from "@/services/auth";
import { CommissionService } from "@/services/commission";
import { CompanyUserService } from "@/services/company-user";
import { MatchingService } from "@/services/matching";
import {
  NotificationDispatcher,
  type EmailSender,
  type SmsSender,
} from "@/services/notifications";
import { OfferService } from "@/services/offer";
import { OrderService } from "@/services/order";
import { BcryptPasswordHasher, type PasswordHasher } from "@/services/password";
import { RequestService } from "@/services/request";
import { SiteService } from "@/services/site";
import { SupplierService } from "@/services/supplier";
import type { TicketPhotoStorage } from "@/services/ticket-photo";

/**
 * Stand-in for an unconfigured SMS transport, mirroring
 * `UnconfiguredEmailSender`. It rejects, so the dispatcher records the miss
 * rather than the deployment silently believing it paged somebody.
 */
export class UnconfiguredSmsSender implements SmsSender {
  async send(): Promise<void> {
    throw new Error("No SMS transport is configured");
  }
}

/** Everything a route handler may delegate to. */
export interface Services {
  repo: Repository;
  sessions: SessionStore;
  auth: AuthService;
  users: CompanyUserService;
  sites: SiteService;
  requests: RequestService;
  matching: MatchingService;
  offers: OfferService;
  orders: OrderService;
  admin: AdminService;
  commission: CommissionService;
  suppliers: SupplierService;
  audit: AuditService;
  notifier: NotificationDispatcher;
  /** Absent when no object storage is configured; uploads then no-op. */
  ticketPhotos?: TicketPhotoStorage;
}

export interface ServiceDeps {
  repo: Repository;
  sessions: SessionStore;
  hasher: PasswordHasher;
  sms: SmsSender;
  email?: EmailSender;
  ticketPhotos?: TicketPhotoStorage;
}

/**
 * Builds the service graph over the supplied ports. Pure assembly: no
 * environment reads, no I/O, no singletons — so a test can wire the same graph
 * over an in-memory repository and in-memory transports and exercise the real
 * handlers against it.
 */
export function createServices(deps: ServiceDeps): Services {
  const { repo, sessions, hasher } = deps;

  // Leaf services first: these depend only on the repository.
  const audit = new AuditService({ repo });
  const notifier = new NotificationDispatcher({
    sms: deps.sms,
    email: deps.email,
  });
  const admin = new AdminService({ repo });
  const suppliers = new SupplierService({ repo });
  const sites = new SiteService({ repo });
  const users = new CompanyUserService({ repo, hasher });
  const auth = new AuthService({ repo, sessions, hasher });
  const commission = new CommissionService({ repo, audit });

  // The cycle, tied with a thunk (see the module note).
  let requests!: RequestService;
  const matching = new MatchingService({
    repo,
    expiry: {
      expireIfWindowEnded: (request, now) =>
        requests.expireIfWindowEnded(request, now),
    },
  });
  requests = new RequestService({ repo, admin, matching, notifier, audit });

  const offers = new OfferService({ repo, notifier, audit });
  const orders = new OrderService({ repo, notifier, commission, audit });

  return {
    repo,
    sessions,
    auth,
    users,
    sites,
    requests,
    matching,
    offers,
    orders,
    admin,
    commission,
    suppliers,
    audit,
    notifier,
    ticketPhotos: deps.ticketPhotos,
  };
}

/**
 * The error a production boot without `DATABASE_URL` fails with. Exported so
 * the message lives in one place and a test can assert on it.
 */
export const MISSING_DATABASE_URL_MESSAGE =
  "DATABASE_URL is not set. A production deployment must run on Postgres: " +
  "without it the app would start on the in-memory repository and lose every " +
  "company, user, request, order and session on the next restart. Set " +
  "DATABASE_URL (on Render it is wired from the database instance) and " +
  "redeploy. For local development, leave it unset and the in-memory " +
  "adapters are used instead.";

/**
 * Builds the production graph from the environment.
 *
 * ## Persistence is chosen by `DATABASE_URL`
 *
 * With `DATABASE_URL` set, the graph is wired over `PrismaRepository` and
 * `PrismaSessionStore` and the pilot's state outlives the process. With it
 * unset, the in-memory pair is used instead, so `next dev`, a smoke run, and
 * the test suite all work with nothing installed. Because both adapters are
 * held to one behavioural contract (`repository-contract.ts`), nothing
 * downstream can tell which one it got.
 *
 * ## Except in production, where there is no fallback
 *
 * That silence is a virtue in development and a trap on a hosted deploy: an
 * instance with no `DATABASE_URL` would boot, serve, accept orders, and drop
 * all of it on the next restart or route a second instance to a different
 * copy of reality. So when `NODE_ENV === "production"` and `DATABASE_URL` is
 * absent, this throws instead of falling back. A deploy that cannot persist
 * should fail loudly at boot, not quietly at 2am.
 *
 * Outside production the fallback is unchanged: `next dev` and the test suite
 * depend on it, and "is a database reachable" remains the only question asked
 * there.
 *
 * Sessions move with the repository rather than staying in-process. Leaving
 * them in a map while rows went to Postgres would mean a redeploy silently
 * signed every driver out mid-shift and a second instance never recognised
 * them at all; the `Session` table already exists for exactly this.
 */
export function createServicesFromEnv(): Services {
  if (!isDatabaseConfigured() && process.env.NODE_ENV === "production") {
    throw new Error(MISSING_DATABASE_URL_MESSAGE);
  }

  const prisma = isDatabaseConfigured() ? getPrismaClient() : null;

  return createServices({
    repo: prisma ? new PrismaRepository(prisma) : new InMemoryRepository(),
    sessions: prisma
      ? new PrismaSessionStore(prisma)
      : new InMemorySessionStore(),
    hasher: new BcryptPasswordHasher(),
    sms: isTwilioConfigured()
      ? TwilioSmsSender.fromEnv()
      : new UnconfiguredSmsSender(),
    email: isSmtpConfigured() ? SmtpEmailSender.fromEnv() : undefined,
    ticketPhotos: isS3TicketPhotoConfigured()
      ? S3TicketPhotoStorage.fromEnv()
      : undefined,
  });
}

/**
 * The process-wide graph the route handlers use.
 *
 * Built once and cached, for a different reason on each side of the switch:
 * without a database the in-memory repository and session store *are* the
 * pilot's state, so rebuilding per request would drop every session and every
 * row; with one, a fresh graph would mean a fresh connection pool per request.
 * Route handlers import `getServices()` and nothing else from here, so the
 * singleton is confined to this module and never reaches a service.
 */
let cached: Services | null = null;

export function getServices(): Services {
  if (!cached) cached = createServicesFromEnv();
  return cached;
}

/** Test/dev helper: drops the cached graph so the next call rebuilds it. */
export function resetServices(): void {
  cached = null;
}
