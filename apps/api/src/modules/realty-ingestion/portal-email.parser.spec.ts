import { parsePortalEmail } from './portal-email.parser';
import { RealtyPortal } from '@gosumo/shared';

describe('parsePortalEmail', () => {
  it('parses a 99acres enquiry with labelled fields', () => {
    const email = {
      from: 'noreply@99acres.com',
      subject: 'New response for your property',
      text: [
        'You have a new enquiry.',
        'Name: Priya Sharma',
        'Phone: +91-98765 43210',
        'Email: priya@example.com',
        'Property: 3BHK in Whitefield',
      ].join('\n'),
    };
    const c = parsePortalEmail(email);
    expect(c).not.toBeNull();
    expect(c!.portal).toBe(RealtyPortal.NINETYNINE_ACRES);
    expect(c!.name).toBe('Priya Sharma');
    expect(c!.phone).toMatch(/98765/);
    expect(c!.email).toBe('priya@example.com');
    expect(c!.listingRef).toBe('3BHK in Whitefield');
  });

  it('detects MagicBricks and Housing from the sender', () => {
    const mb = parsePortalEmail({ from: 'leads@magicbricks.com', text: 'Mobile: 9876543210' });
    expect(mb!.portal).toBe(RealtyPortal.MAGICBRICKS);
    const hs = parsePortalEmail({ from: 'alerts@housing.com', text: 'Contact: 9812345678' });
    expect(hs!.portal).toBe(RealtyPortal.HOUSING);
  });

  it('falls back to the first phone-shaped token when unlabelled', () => {
    const c = parsePortalEmail({ from: 'x@99acres.com', text: 'Buyer reached out at 9811122233 today.' });
    expect(c!.phone).toMatch(/9811122233/);
  });

  it('strips HTML when only html is provided', () => {
    const c = parsePortalEmail({
      from: 'noreply@housing.com',
      html: '<p>Name: <b>Amit</b></p><p>Phone: 9877766655</p>',
    });
    expect(c!.name).toContain('Amit');
    expect(c!.phone).toMatch(/9877766655/);
  });

  it('returns null when no phone can be recovered', () => {
    expect(parsePortalEmail({ from: 'x@99acres.com', text: 'no contact here' })).toBeNull();
    expect(parsePortalEmail({ from: 'x@99acres.com' })).toBeNull();
  });

  it('marks an unrecognised sender as UNKNOWN but still ingests', () => {
    const c = parsePortalEmail({ from: 'random@somewhere.com', subject: 'Lead', text: 'Phone: 9800011122' });
    expect(c!.portal).toBe(RealtyPortal.UNKNOWN);
    expect(c!.listingRef).toBe('Lead');
  });
});
