import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(): Buffer {
  const raw =
    process.env.CHANNEL_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "gosumo-default-key-32b";
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
      // ignore
    }
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
