/**
 * Generate a random UUID v4.
 * Uses the Node.js built-in crypto module — no external dependency required.
 */
export declare function generateId(): string;
/**
 * Generate a correlation ID for tracing a request across services.
 * Format: gs-<timestamp_hex>-<uuid_without_dashes_prefix8>
 * Example: gs-018f3a2b1c4d-a1b2c3d4
 */
export declare function generateCorrelationId(): string;
/**
 * Convert a monetary amount in paise (smallest INR unit) to a
 * human-readable currency string.
 *
 * @param paise - Integer amount in paise (e.g. 10050 = ₹100.50)
 * @returns Formatted string, e.g. "₹100.50"
 */
export declare function paiseToCurrency(paise: number): string;
/**
 * Convert a decimal rupee amount to paise (integer).
 * Rounds to the nearest paise to handle floating-point drift.
 *
 * @param amount - Amount in rupees (e.g. 100.5 → 10050)
 * @returns Integer paise value
 */
export declare function currencyToPaise(amount: number): number;
/**
 * Normalize a raw Indian phone number to E.164 (`+91XXXXXXXXXX`).
 *
 * Handles the common shapes seen across portals, CSV exports, and ad forms:
 * `+91 98765 43210`, `0091-9876543210`, `09876543210`, `9876543210`,
 * `91 9876543210`, and numbers with spaces / hyphens / parentheses. Returns
 * `null` when the input cannot be resolved to a valid 10-digit Indian mobile
 * (leading digit 6–9) — callers treat `null` as an unusable identity.
 *
 * This is the single authorized phone-normalization point (root rule: phones
 * are stored E.164). Ingestion merges leads on the E.164 result.
 */
export declare function normalizeIndianPhone(raw: string | null | undefined): string | null;
