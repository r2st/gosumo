"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateId = generateId;
exports.generateCorrelationId = generateCorrelationId;
exports.currencyToPaise = currencyToPaise;
exports.normalizeIndianPhone = normalizeIndianPhone;
const crypto_1 = require("crypto");
/**
 * Generate a random UUID v4.
 * Uses the Node.js built-in crypto module — no external dependency required.
 */
function generateId() {
    return (0, crypto_1.randomUUID)();
}
/**
 * Generate a correlation ID for tracing a request across services.
 * Format: gs-<timestamp_hex>-<uuid_without_dashes_prefix8>
 * Example: gs-018f3a2b1c4d-a1b2c3d4
 */
function generateCorrelationId() {
    const ts = Date.now().toString(16);
    const uid = (0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 8);
    return `gs-${ts}-${uid}`;
}
/**
 * Convert a decimal rupee amount to paise (integer).
 * Rounds to the nearest paise to handle floating-point drift.
 *
 * @param amount - Amount in rupees (e.g. 100.5 → 10050)
 * @returns Integer paise value
 */
function currencyToPaise(amount) {
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * 100);
}
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
function normalizeIndianPhone(raw) {
    if (!raw)
        return null;
    // Strip everything except digits and a possible leading '+'.
    let cleaned = raw.trim().replace(/[^\d+]/g, '');
    if (!cleaned)
        return null;
    // Drop a leading '+' for uniform digit handling.
    const hadPlus = cleaned.startsWith('+');
    if (hadPlus)
        cleaned = cleaned.slice(1);
    // Strip international/trunk prefixes: 0091, 091, 91, and a single trunk 0.
    if (cleaned.startsWith('0091'))
        cleaned = cleaned.slice(4);
    else if (cleaned.startsWith('91') && cleaned.length === 12)
        cleaned = cleaned.slice(2);
    else if (cleaned.startsWith('0') && cleaned.length === 11)
        cleaned = cleaned.slice(1);
    // What remains must be a 10-digit mobile starting 6–9.
    if (!/^[6-9]\d{9}$/.test(cleaned))
        return null;
    return `+91${cleaned}`;
}
//# sourceMappingURL=index.js.map