/**
 * RealtyContradictionService unit tests — Phase 7.
 *
 * The pure logic is covered in bltc-contradiction.util.spec; here we verify the
 * service wiring: DTO-shaped input is normalized to a full profile, and a stored
 * lead's BLTC is fetched (tenant-scoped) and validated.
 */

import { RealtyContradictionService, toBltcProfile } from './realty-contradiction.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const LEAD = '00000000-0000-4000-a000-000000000010';

describe('toBltcProfile', () => {
  it('fills unknown slots with null/[]', () => {
    expect(toBltcProfile({ budgetMaxPaise: 5000000 })).toEqual({
      budgetMinPaise: null,
      budgetMaxPaise: 5000000,
      localities: [],
      timelineMonths: null,
      config: null,
      purpose: null,
      financing: null,
    });
  });
});

describe('RealtyContradictionService', () => {
  let leads: { getLead: jest.Mock };
  let service: RealtyContradictionService;

  beforeEach(() => {
    leads = { getLead: jest.fn() };
    service = new RealtyContradictionService(leads as never);
  });

  it('validates a supplied (partial) profile', () => {
    const res = service.validateProfile({ budgetMinPaise: 80e5, budgetMaxPaise: 50e5 });
    expect(res.hasErrors).toBe(true);
    expect(res.contradictions.map((c) => c.code)).toContain('budget_min_gt_max');
  });

  it('fetches a stored lead tenant-scoped and validates its BLTC', async () => {
    leads.getLead.mockResolvedValue({
      bltc: {
        // ₹40L–₹60L (LAKH = 1e7 paise), clears the 2BHK floor.
        budgetMinPaise: 4e8,
        budgetMaxPaise: 6e8,
        localities: ['Baner'],
        timelineMonths: 6,
        config: '2BHK',
        purpose: 'END_USE',
        financing: 'CASH',
      },
    });
    const res = await service.validateLead(BIZ, LEAD);
    expect(leads.getLead).toHaveBeenCalledWith(BIZ, LEAD);
    expect(res.consistent).toBe(true);
  });

  it('surfaces contradictions from a stored lead', async () => {
    leads.getLead.mockResolvedValue({
      bltc: {
        budgetMinPaise: null,
        budgetMaxPaise: 20e5,
        localities: [],
        timelineMonths: 240,
        config: '4BHK',
        purpose: null,
        financing: null,
      },
    });
    const res = await service.validateLead(BIZ, LEAD);
    const codes = res.contradictions.map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['timeline_implausible', 'budget_below_config_floor']));
  });
});
