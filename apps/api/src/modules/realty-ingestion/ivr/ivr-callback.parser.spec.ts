import { parseIvrCallback } from './ivr-callback.parser';

describe('parseIvrCallback', () => {
  it('parses an Exotel missed-call payload', () => {
    const call = parseIvrCallback({
      CallFrom: '09876543210',
      CallTo: '08040001111',
      DateCreated: '2026-07-03 10:15:00',
      CallSid: 'exo_abc',
      CampaignId: 'launch-jul',
    });
    expect(call).toMatchObject({
      phone: '09876543210',
      calledNumber: '08040001111',
      campaignId: 'launch-jul',
      provider: 'exotel',
    });
    expect(call!.callTime).toBe(new Date('2026-07-03 10:15:00').toISOString());
    expect(call!.raw).toMatchObject({ CallSid: 'exo_abc' });
  });

  it('falls back to CallSid as the campaign id for Exotel', () => {
    const call = parseIvrCallback({ CallFrom: '9876543210', CallSid: 'exo_xyz' });
    expect(call).toMatchObject({ provider: 'exotel', campaignId: 'exo_xyz' });
  });

  it('parses a Knowlarity missed-call payload', () => {
    const call = parseIvrCallback({
      caller_id: '+919876543210',
      called_number: '+918040001111',
      start_time: '2026-07-03T10:15:00Z',
      campaign_name: 'billboard-mg-road',
      uuid: 'kn_1',
    });
    expect(call).toMatchObject({
      phone: '+919876543210',
      calledNumber: '+918040001111',
      campaignId: 'billboard-mg-road',
      provider: 'knowlarity',
    });
  });

  it('parses the generic/canonical shape', () => {
    const call = parseIvrCallback({
      phone: '9876543210',
      calledNumber: '8040001111',
      callTime: '2026-07-03T10:15:00Z',
      campaignId: 'generic-1',
    });
    expect(call).toMatchObject({ phone: '9876543210', provider: 'generic', campaignId: 'generic-1' });
  });

  it('accepts numeric phone fields', () => {
    const call = parseIvrCallback({ CallFrom: 9876543210 });
    expect(call).toMatchObject({ phone: '9876543210', provider: 'exotel' });
  });

  it('drops an unparseable call time rather than fabricating one', () => {
    const call = parseIvrCallback({ phone: '9876543210', callTime: 'not-a-date' });
    expect(call!.callTime).toBeUndefined();
  });

  it('returns null when there is no caller phone', () => {
    expect(parseIvrCallback({ CallTo: '8040001111' })).toBeNull();
    expect(parseIvrCallback({ called_number: '8040001111' })).toBeNull();
    expect(parseIvrCallback({ foo: 'bar' })).toBeNull();
    expect(parseIvrCallback(null)).toBeNull();
    expect(parseIvrCallback('nope')).toBeNull();
  });
});
