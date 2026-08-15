/**
 * Largest `quantity` the price endpoint will multiply by.
 *
 * Not a statement about how much a customer may buy — the order module owns
 * that, against real stock. This exists because `getEffectivePrice` returns
 * `finalPricePaise * quantity` as `totalPaise`, and paise are an integer by
 * rule #4: past `Number.MAX_SAFE_INTEGER` the multiplication silently stops
 * being exact, so the endpoint would answer 200 with a number that is close
 * to the right price and is not the right price.
 *
 * One million at ₹10,00,000 an item is ~1e15 paise — still comfortably inside
 * a safe integer, and several orders of magnitude past any catalogue line a
 * small business in India actually quotes.
 */
export const MAX_PRICE_QUANTITY = 1_000_000;
