/**
 * S3 adapter — the production `TicketPhotoStorage` (Requirement 11.6).
 *
 * As thin as the Twilio and SMTP adapters: read configuration, hand the object
 * to S3, let any failure propagate. The behaviour worth testing — that an
 * upload failure is non-fatal and the Delivery still records its gallons and
 * ticket number — lives in `uploadTicketPhoto`, which never sees this file, so
 * no test ever reaches the S3 API.
 *
 * Environment:
 *   S3_TICKET_BUCKET       Bucket for BOL ticket photos.
 *   AWS_REGION             Region. Defaults to us-west-2 (Phoenix pilot).
 *   S3_ENDPOINT            Optional, for an S3-compatible store (MinIO, R2).
 *   AWS_ACCESS_KEY_ID      Optional: omit to use the instance/role credential
 *   AWS_SECRET_ACCESS_KEY  chain, which is the production arrangement.
 *
 * Construction is lazy on purpose. `fromEnv` throws when the bucket is
 * missing, but nothing calls it at import time, so a deployment without object
 * storage fails on the first upload attempt — recorded as a null photo key —
 * rather than crashing the server on boot.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type {
  TicketPhotoStorage,
  TicketPhotoUpload,
} from "@/services/ticket-photo";

export const DEFAULT_S3_REGION = "us-west-2";

export interface S3TicketPhotoConfig {
  bucket: string;
  region: string;
  /** Set for an S3-compatible endpoint; forces path-style addressing. */
  endpoint?: string;
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

/** Reads S3 configuration from the environment. Throws when incomplete. */
export function s3TicketPhotoConfigFromEnv(): S3TicketPhotoConfig {
  const bucket = optionalEnv("S3_TICKET_BUCKET");
  if (bucket === undefined) {
    // Names the key, never a credential value.
    throw new Error("Missing required environment variable S3_TICKET_BUCKET");
  }
  return {
    bucket,
    region: optionalEnv("AWS_REGION") ?? DEFAULT_S3_REGION,
    endpoint: optionalEnv("S3_ENDPOINT"),
  };
}

/** True when a bucket is configured — lets a caller decide whether to wire S3. */
export function isS3TicketPhotoConfigured(): boolean {
  return optionalEnv("S3_TICKET_BUCKET") !== undefined;
}

export class S3TicketPhotoStorage implements TicketPhotoStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3TicketPhotoConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        // Credentials are deliberately not passed: the default chain picks up
        // the task/instance role in production and `AWS_*` locally.
        ...(config.endpoint
          ? { endpoint: config.endpoint, forcePathStyle: true }
          : {}),
      });
  }

  /** Builds the adapter from `S3_TICKET_BUCKET`; throws when unconfigured. */
  static fromEnv(): S3TicketPhotoStorage {
    return new S3TicketPhotoStorage(s3TicketPhotoConfigFromEnv());
  }

  async put(upload: TicketPhotoUpload): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: upload.key,
        Body: upload.body,
        ContentType: upload.contentType,
      })
    );
    return upload.key;
  }
}
