/**
 * Password hashing port and its bcrypt implementation.
 *
 * The service layer depends on the `PasswordHasher` interface only, so auth
 * logic stays pure and fast to test; production wires the bcrypt adapter.
 *
 * bcrypt is used as-is from `bcryptjs` (a maintained, zero-dependency bcrypt
 * implementation with first-party TypeScript types, pinned to an exact
 * version). No crypto is hand-rolled here.
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

/**
 * bcrypt cost factor. 12 is above the OWASP floor of 10 and costs ~200ms per
 * hash/verify on the pilot's hardware, which is an acceptable login latency.
 */
export const DEFAULT_BCRYPT_COST = 12;

export interface PasswordHasher {
  /** Hashes a plaintext password, producing a self-describing hash string. */
  hash(password: string): Promise<string>;
  /**
   * Verifies a plaintext password against a stored hash. Never throws for a
   * malformed or unknown hash — it returns false — so callers can keep a
   * single uniform failure path.
   */
  verify(password: string, hash: string): Promise<boolean>;
  /**
   * A valid hash of an unguessable value, used to spend the same work when no
   * user matched the submitted identifier. This keeps login timing (and the
   * returned error) independent of whether the identifier existed.
   */
  decoyHash(): Promise<string>;
}

export class BcryptPasswordHasher implements PasswordHasher {
  private readonly cost: number;
  private decoy: Promise<string> | null = null;

  constructor(cost: number = DEFAULT_BCRYPT_COST) {
    this.cost = cost;
  }

  async hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.cost);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    try {
      // bcrypt.compare re-derives the candidate hash with the stored salt and
      // compares the results; it does not leak the stored hash.
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }

  async decoyHash(): Promise<string> {
    // Generated once per process at the configured cost so a failed lookup
    // costs the same as a failed password check.
    this.decoy ??= bcrypt.hash(randomBytes(32).toString("base64url"), this.cost);
    return this.decoy;
  }
}
