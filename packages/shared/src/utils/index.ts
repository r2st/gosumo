import { randomUUID } from 'crypto';

/**
 * Generate a random UUID v4.
 * Uses the Node.js built-in crypto module — no external dependency required.
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Generate a correlation ID for tracing a request across services.
 * Format: gs-<timestamp_hex>-<uuid_without_dashes_prefix8>
 * Example: gs-018f3a2b1c4d-a1b2c3d4
 */
export function generateCorrelationId(): string {
  const ts = Date.now().toString(16);
  const uid = randomUUID().replace(/-/g, '').slice(0, 8);
  return `gs-${ts}-${uid}`;
}

/**
 * Convert a monetary amount in paise (smallest INR unit) to a
 * human-readable currency string.
 *
 * @param paise - Integer amount in paise (e.g. 10050 = ₹100.50)
 * @returns Formatted string, e.g. "₹100.50"
 */
export function paiseToCurrency(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toFixed(2)}`;
}

/**
 * Convert a decimal rupee amount to paise (integer).
 * Rounds to the nearest paise to handle floating-point drift.
 *
 * @param amount - Amount in rupees (e.g. 100.5 → 10050)
 * @returns Integer paise value
 */
export function currencyToPaise(amount: number): number {
  return Math.round(amount * 100);
}
