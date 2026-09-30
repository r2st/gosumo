import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * The last-resort key material. It is a literal in a source file, so it is
 * known to anyone who can read this repository — which makes anything encrypted
 * under it encrypted in name only.
 *
 * It exists so that `pnpm dev` works on a clean checkout. `assertChannelEncryptionKey`
 * is what stops it reaching production.
 */
export const FALLBACK_CHANNEL_KEY = "gosumo-default-key-32b";

/**
 * Shorter than this and the SHA-256 below is stretching very little entropy
 * across a 256-bit key. Not a hard failure — a deployer who set the variable
 * has made a deliberate choice — but worth saying out loud.
 */
export const MIN_CHANNEL_KEY_LENGTH = 32;

/** Where the key actually came from, in the order `deriveKey` tries them. */
export type ChannelKeySource = "explicit" | "jwt-secret" | "built-in-default";

export interface ChannelKeyCheck {
  source: ChannelKeySource;
  severity: "ok" | "warn" | "fatal";
  /** Null when there is nothing to say. */
  message: string | null;
}

/** Which of the three sources supplies the key, given an environment. */
export function channelKeySource(
  env: NodeJS.ProcessEnv = process.env,
): ChannelKeySource {
  if (env.CHANNEL_ENCRYPTION_KEY) return "explicit";
  if (env.JWT_SECRET) return "jwt-secret";
  return "built-in-default";
}

/**
 * Judge the channel-encryption key at startup.
 *
 * `deriveKey` falls through three sources silently, and the two fallbacks fail
 * in ways nothing downstream can detect: `decryptJson` returns `{}` rather than
 * throwing when a key does not match, so credentials encrypted under one key
 * simply read back as absent under another. A deployment can therefore be
 * wrong — or become wrong — without a single error being logged.
 *
 * Which is why the `jwt-secret` case is a warning and not a shrug. Rotating
 * `JWT_SECRET` is routine security hygiene, and doing it while the channel key
 * is derived from it silently empties every stored channel credential in the
 * database: no exception, no log line, just channels that quietly stop
 * authenticating. Nothing about `JWT_SECRET` announces that it is load-bearing
 * for anything but tokens.
 *
 * Outside production nothing is reported — a clean checkout is meant to run.
 */
export function assertChannelEncryptionKey(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = (env.NODE_ENV ?? "development") === "production",
): ChannelKeyCheck {
  const source = channelKeySource(env);

  if (!isProduction) return { source, severity: "ok", message: null };

  if (source === "built-in-default") {
    return {
      source,
      severity: "fatal",
      message:
        "CHANNEL_ENCRYPTION_KEY is not set and neither is JWT_SECRET, so stored channel " +
        `credentials would be encrypted under the constant "${FALLBACK_CHANNEL_KEY}" that ships ` +
        "in this repository — readable by anyone who can read the source. Set " +
        "CHANNEL_ENCRYPTION_KEY to a random secret (openssl rand -base64 48) before starting.",
    };
  }

  if (source === "jwt-secret") {
    return {
      source,
      severity: "warn",
      message:
        "CHANNEL_ENCRYPTION_KEY is not set; the channel-credential key is being derived from " +
        "JWT_SECRET. That works, but it makes JWT_SECRET undroppable: rotating it re-keys " +
        "every stored credential, and because decryption failure returns an empty object " +
        "rather than an error, those credentials would silently read back as absent instead " +
        "of failing loudly. Set CHANNEL_ENCRYPTION_KEY explicitly.",
    };
  }

  if ((env.CHANNEL_ENCRYPTION_KEY ?? "").length < MIN_CHANNEL_KEY_LENGTH) {
    return {
      source,
      severity: "warn",
      message:
        `CHANNEL_ENCRYPTION_KEY is shorter than ${MIN_CHANNEL_KEY_LENGTH} characters. It is ` +
        "hashed to 256 bits regardless, which hides how little entropy is actually behind it.",
    };
  }

  return { source, severity: "ok", message: null };
}

function deriveKey(): Buffer {
  const raw =
    process.env.CHANNEL_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    FALLBACK_CHANNEL_KEY;
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypt a JS object using AES-256-GCM.
 * Returns a base64 string containing iv + authTag + ciphertext.
 */
export function encryptJson(data: Record<string, unknown>): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // iv (16) + authTag (16) + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM string back to a JS object.
 * If decryption fails, tries parsing as plain JSON (backwards compat).
 * If that also fails, returns {}.
 */
export function decryptJson(encoded: string): Record<string, unknown> {
  try {
    const key = deriveKey();
    const combined = Buffer.from(encoded, "base64");

    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    // Backwards compat: try parsing as plain JSON
    try {
      const parsed = JSON.parse(encoded);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Both decryption and plain-JSON parse failed — the stored value is
      // unrecoverable with the current key material.
    }
    const preview = encoded.length > 8 ? encoded.slice(0, 8) + '…' : encoded;
    console.warn(
      `[decryptJson] Failed to decrypt or parse credential (starts "${preview}"); returning empty object`,
    );
    return {};
  }
}

const SECRET_FIELD_PATTERNS = [
  "token",
  "secret",
  "password",
  "key",
  "auth",
  "sid",
];

function isSecretField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SECRET_FIELD_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Mask credential fields for safe display.
 * Secret-looking fields show { set: true, last4: "..." }.
 * Non-secret fields show { set: boolean, value: string }.
 */
export function maskCredentialFields(
  creds: Record<string, unknown>,
): Record<string, { set: boolean; last4?: string; value?: string }> {
  const result: Record<string, { set: boolean; last4?: string; value?: string }> = {};

  for (const [field, value] of Object.entries(creds)) {
    const strValue = typeof value === "string" ? value : String(value ?? "");
    const hasValue = !!value && strValue.length > 0;

    if (isSecretField(field)) {
      result[field] = {
        set: hasValue,
        ...(hasValue && strValue.length >= 4
          ? { last4: strValue.slice(-4) }
          : {}),
      };
    } else {
      result[field] = {
        set: hasValue,
        value: hasValue ? strValue : undefined,
      };
    }
  }

  return result;
}
