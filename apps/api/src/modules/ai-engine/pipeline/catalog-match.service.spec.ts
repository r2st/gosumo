import { Logger } from '@nestjs/common';
import { IntentType } from '@gosumo/shared';
import {
  CatalogMatchService,
  extractProductTerms,
  PRICE_BEARING_INTENTS,
} from './catalog-match.service';
import { CatalogService } from '../../catalog/catalog.service';

const BUSINESS_ID = '660e8400-e29b-41d4-a716-446655440000';

interface Fakes {
  service: CatalogMatchService;
  listItems: jest.Mock;
  searchCatalog: jest.Mock;
}

function makeService(opts: { catalogSize?: number; hits?: string[] } = {}): Fakes {
  const listItems = jest.fn().mockResolvedValue({ total: opts.catalogSize ?? 10, data: [] });
  // `hits` lists the terms the catalog knows about; anything else misses.
  const searchCatalog = jest
    .fn()
    .mockImplementation(async (_biz: string, term: string) =>
      (opts.hits ?? []).includes(term) ? [{ id: 'item-1', name: term }] : [],
    );
  const service = new CatalogMatchService({
    listItems,
    searchCatalog,
  } as unknown as CatalogService);
  return { service, listItems, searchCatalog };
}

describe('extractProductTerms', () => {
  it('keeps the product word out of a plain English price question', () => {
    expect(extractProductTerms('what is the price of paneer?')).toEqual(['paneer']);
  });

  it('keeps the product word out of a Hinglish price question', () => {
    expect(extractProductTerms('bhai tamatar kitne ka hai')).toEqual(['tamatar']);
  });

  it('drops bare quantities, which are never products', () => {
    expect(extractProductTerms('2 kilo aloo chahiye 500')).toEqual(['aloo']);
  });

  it('drops price vocabulary that would match half a catalog', () => {
    // A term like "price" or "rate" appears in some description in almost any
    // catalog, and a single spurious hit reports the item as stocked — the
    // exact failure this check exists to prevent.
    expect(extractProductTerms('price rate cost daam kitna')).toEqual([]);
  });

  it('ignores punctuation and case', () => {
    expect(extractProductTerms('PANEER, butter-masala!')).toEqual(['paneer', 'butter', 'masala']);
  });

  it('de-duplicates repeated words', () => {
    expect(extractProductTerms('paneer paneer paneer')).toEqual(['paneer']);
  });

  it('bounds the number of terms searched for', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india';
    expect(extractProductTerms(text).length).toBeLessThanOrEqual(5);
  });

  it('returns nothing for a message with no candidate product at all', () => {
    expect(extractProductTerms('kitna hai?')).toEqual([]);
  });
});

describe('CatalogMatchService', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => jest.restoreAllMocks());

  describe('intent gating', () => {
    it.each(PRICE_BEARING_INTENTS)('evaluates %s', async (intent) => {
      const { service, searchCatalog } = makeService();
      await service.evaluate(BUSINESS_ID, intent, 'paneer kitne ka');
      expect(searchCatalog).toHaveBeenCalled();
    });

    it.each([IntentType.COMPLAINT, IntentType.CHIT_CHAT, IntentType.REFUND, IntentType.BOOKING])(
      'stays out of the way for %s',
      async (intent) => {
        const { service, listItems, searchCatalog } = makeService();

        await expect(service.evaluate(BUSINESS_ID, intent, 'paneer kitne ka')).resolves.toEqual({});
        // Not even the size probe — an intent that is not quoting a price must
        // cost nothing.
        expect(listItems).not.toHaveBeenCalled();
        expect(searchCatalog).not.toHaveBeenCalled();
      },
    );
  });

  describe('signals', () => {
    it('reports the price override when the item is not stocked', async () => {
      const { service } = makeService({ catalogSize: 40, hits: ['paneer'] });

      await expect(
        service.evaluate(BUSINESS_ID, IntentType.PRICING, 'kaju katli kitne ki hai'),
      ).resolves.toEqual({ catalogMatch: false, priceNotInCatalog: true });
    });

    it('reports a match when any term hits the catalog', async () => {
      const { service } = makeService({ hits: ['paneer'] });

      await expect(
        service.evaluate(BUSINESS_ID, IntentType.PRICING, 'fresh paneer price please'),
      ).resolves.toEqual({ catalogMatch: true, priceNotInCatalog: false });
    });

    it('stops searching as soon as a term matches', async () => {
      const { service, searchCatalog } = makeService({ hits: ['alpha'] });

      await service.evaluate(BUSINESS_ID, IntentType.PRICING, 'alpha bravo charlie delta echo');

      expect(searchCatalog).toHaveBeenCalledTimes(1);
    });

    it('gives no signal for a tenant with no catalog at all', async () => {
      // Plenty of businesses keep their price list in the knowledge base.
      // Flagging every one of their pricing questions as an unstocked item
      // would escalate the whole intent for them, which is a behaviour change
      // unrelated to the bug this check fixes.
      const { service, searchCatalog } = makeService({ catalogSize: 0 });

      await expect(
        service.evaluate(BUSINESS_ID, IntentType.PRICING, 'kaju katli kitne ki hai'),
      ).resolves.toEqual({});
      expect(searchCatalog).not.toHaveBeenCalled();
    });

    it('gives no signal when the message names no product', async () => {
      const { service, listItems } = makeService();

      await expect(service.evaluate(BUSINESS_ID, IntentType.PRICING, 'kitna?')).resolves.toEqual({});
      expect(listItems).not.toHaveBeenCalled();
    });

    it('scopes every lookup to the calling tenant', async () => {
      const { service, listItems, searchCatalog } = makeService({ hits: [] });

      await service.evaluate(BUSINESS_ID, IntentType.PRICING, 'paneer kitne ka');

      expect(listItems).toHaveBeenCalledWith(BUSINESS_ID, expect.anything());
      expect(searchCatalog).toHaveBeenCalledWith(BUSINESS_ID, 'paneer', expect.any(Number));
    });
  });

  describe('degradation', () => {
    it('gives no signal when the catalog read fails', async () => {
      // "Not in catalog" because the database blinked would escalate every
      // pricing conversation for the duration of the outage; a match would be
      // worse still. Neither claim is safe to make without a live read.
      const { service } = makeService();
      (service as unknown as { catalog: { listItems: jest.Mock } }).catalog.listItems.mockRejectedValue(
        new Error('connection terminated'),
      );

      await expect(
        service.evaluate(BUSINESS_ID, IntentType.PRICING, 'paneer kitne ka'),
      ).resolves.toEqual({});
    });

    it('gives no signal when a term search fails', async () => {
      const { service, searchCatalog } = makeService();
      searchCatalog.mockRejectedValue(new Error('timeout'));

      await expect(
        service.evaluate(BUSINESS_ID, IntentType.PRICING, 'paneer kitne ka'),
      ).resolves.toEqual({});
    });
  });
});
