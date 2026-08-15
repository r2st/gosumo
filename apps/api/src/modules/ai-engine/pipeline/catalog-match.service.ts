import { Injectable, Logger } from '@nestjs/common';
import { IntentType } from '@gosumo/shared';
import { CatalogService } from '../../catalog/catalog.service';

/**
 * Intents whose reply is expected to name a product and its price.
 *
 * PRICING is the obvious one. ORDER is here for the same reason: confirming
 * "2 kilo tomatoes, ₹80" for something the business does not sell is the same
 * invention as quoting a price for it, and it commits the business further.
 */
export const PRICE_BEARING_INTENTS: readonly IntentType[] = [
  IntentType.PRICING,
  IntentType.ORDER,
];

/**
 * Words that never identify a product, so they must not be searched for.
 *
 * A term like "price" or "hai" matches a description somewhere in almost any
 * catalog, and one spurious match is enough to report the item as stocked —
 * which is the failure this whole check exists to prevent. English and the
 * transliterated Hindi the classifier already expects are both covered.
 */
const STOPWORDS = new Set([
  // English — price / order phrasing
  'the', 'this', 'that', 'these', 'those', 'and', 'for', 'with', 'you', 'your',
  'are', 'was', 'were', 'have', 'has', 'can', 'could', 'would', 'please', 'want',
  'need', 'much', 'many', 'how', 'what', 'when', 'where', 'which', 'does', 'did',
  'price', 'prices', 'cost', 'costs', 'rate', 'rates', 'rupees', 'rupee', 'each',
  'per', 'order', 'buy', 'send', 'give', 'get', 'tell', 'know', 'available',
  'stock', 'piece', 'pieces', 'pack', 'box', 'kilo', 'kilos', 'gram', 'grams',
  'litre', 'litres', 'liter', 'liters', 'dozen', 'total', 'amount', 'from',
  'about', 'any', 'all', 'some', 'one', 'two', 'three',
  // Hinglish
  'kitna', 'kitne', 'kitni', 'daam', 'bhav', 'hai', 'hain', 'kya', 'kaise',
  'chahiye', 'lena', 'dena', 'karo', 'karna', 'mujhe', 'aap', 'aapka', 'aapke',
  'nahi', 'haan', 'accha', 'thik', 'bata', 'batao', 'bhai', 'sir', 'madam',
]);

/** Most terms searched for one message — a bound on the query fan-out. */
const MAX_TERMS = 5;
/** Shorter than this and a token is noise, not a product name. */
const MIN_TERM_LENGTH = 3;

/**
 * The candidate product names in a customer message, best-effort.
 *
 * Exported for testing: the whole check turns on which words get searched for.
 */
export function extractProductTerms(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= MIN_TERM_LENGTH &&
        !STOPWORDS.has(token) &&
        // A bare number is a quantity or a price, never a product.
        !/^\d+$/.test(token),
    );

  return [...new Set(tokens)].slice(0, MAX_TERMS);
}

/** What the catalog says about the item a message is asking after. */
export interface CatalogSignal {
  /** A catalog item matched (`false` = looked, found nothing). */
  catalogMatch?: boolean;
  /** Feeds the `PRICE_NOT_IN_CATALOG` hard override. */
  priceNotInCatalog?: boolean;
}

/**
 * CatalogMatchService — answers "does this business actually sell the thing
 * the customer is asking the price of?" for the confidence calculator.
 *
 * The `PRICE_NOT_IN_CATALOG` hard override has existed since the module was
 * written, and the calculator implements it correctly, but nothing ever set
 * its input: `processMessage` never passed `priceNotInCatalog` or
 * `catalogMatch`, so the override was permanently dark and `catalogMatch` sat
 * at its neutral 0.5 for every message. A pricing question about an item the
 * business does not stock therefore scored on RAG depth and policy clarity
 * alone — routinely into AUTO_PILOT — and the model answered it unreviewed
 * from whatever the retrieved documents happened to say. Quoting an invented
 * price straight to a customer is exactly the outcome the override names.
 *
 * The same gap was found and fixed for `REFUND_OVER_LIMIT`; this is its twin.
 */
@Injectable()
export class CatalogMatchService {
  private readonly logger = new Logger(CatalogMatchService.name);

  constructor(private readonly catalog: CatalogService) {}

  /**
   * Best-effort — a catalog read that fails returns no signal rather than a
   * false one. Reporting "not in catalog" because the database was briefly
   * unreachable would escalate every pricing conversation for the duration of
   * the outage; reporting a match would be worse still.
   */
  async evaluate(businessId: string, intent: IntentType, text: string): Promise<CatalogSignal> {
    if (!PRICE_BEARING_INTENTS.includes(intent)) {
      return {};
    }

    const terms = extractProductTerms(text);
    if (terms.length === 0) {
      return {};
    }

    try {
      // A tenant with no catalog at all is not a tenant whose catalog is
      // missing this item. Plenty of businesses keep their price list in the
      // knowledge base instead, and flagging every one of their pricing
      // questions as an unstocked item would escalate the entire intent for
      // them — a behaviour change with nothing to do with the bug being fixed.
      const catalogSize = await this.catalog.listItems(businessId, {
        isActive: true,
        page: 1,
        limit: 1,
      });
      if (catalogSize.total === 0) {
        return {};
      }

      for (const term of terms) {
        const hits = await this.catalog.searchCatalog(businessId, term, 1);
        if (hits.length > 0) {
          return { catalogMatch: true, priceNotInCatalog: false };
        }
      }

      this.logger.debug(
        `No catalog item for business ${businessId} matches [${terms.join(', ')}] — ` +
          `price override applies`,
      );
      return { catalogMatch: false, priceNotInCatalog: true };
    } catch (err) {
      this.logger.warn(
        `Catalog lookup failed for business ${businessId}; scoring without a catalog signal: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  }
}
