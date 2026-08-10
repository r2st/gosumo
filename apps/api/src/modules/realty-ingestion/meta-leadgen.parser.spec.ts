import { parseMetaLeadgen } from './meta-leadgen.parser';

describe('parseMetaLeadgen', () => {
  it('extracts phone/name/email/listing from inline field_data', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'page_1',
          changes: [
            {
              field: 'leadgen',
              value: {
                leadgen_id: 'lg_1',
                form_id: 'form_9',
                ad_id: 'ad_5',
                created_time: '2026-07-01T10:00:00Z',
                field_data: [
                  { name: 'full_name', values: ['Rahul Mehta'] },
                  { name: 'phone_number', values: ['+91 98765 43210'] },
                  { name: 'email', values: ['rahul@example.com'] },
                  { name: 'which_project', values: ['Prestige Lakeside'] },
                ],
              },
            },
          ],
        },
      ],
    };

    const c = parseMetaLeadgen(payload)[0]!;
    expect(c.phone).toBe('+91 98765 43210');
    expect(c.name).toBe('Rahul Mehta');
    expect(c.email).toBe('rahul@example.com');
    expect(c.listingRef).toBe('Prestige Lakeside');
    expect(c.formId).toBe('form_9');
    expect(c.adId).toBe('ad_5');
    expect(c.pageId).toBe('page_1');
    expect(c.leadgenId).toBe('lg_1');
  });

  it('returns a candidate with only leadgen_id when field_data is absent', () => {
    const payload = {
      object: 'page',
      entry: [{ id: 'p', changes: [{ field: 'leadgen', value: { leadgen_id: 'lg_2', form_id: 'f' } }] }],
    };
    const c = parseMetaLeadgen(payload)[0]!;
    expect(c.leadgenId).toBe('lg_2');
    expect(c.phone).toBeUndefined();
  });

  it('ignores non-leadgen changes and malformed payloads', () => {
    expect(parseMetaLeadgen({ object: 'page', entry: [{ changes: [{ field: 'messages' }] }] })).toEqual([]);
    expect(parseMetaLeadgen(null)).toEqual([]);
    expect(parseMetaLeadgen({})).toEqual([]);
    expect(parseMetaLeadgen({ entry: 'nope' })).toEqual([]);
  });

  it('handles multiple leads across entries', () => {
    const mk = (id: string, phone: string) => ({
      changes: [{ field: 'leadgen', value: { leadgen_id: id, field_data: [{ name: 'phone', values: [phone] }] } }],
    });
    const out = parseMetaLeadgen({ entry: [mk('a', '9111111111'), mk('b', '9222222222')] });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.phone)).toEqual(['9111111111', '9222222222']);
  });
});
