/**
 * Billing constants + @PlanLimit decorator unit tests.
 *
 * Coverage: plan-definition resolution (valid tier + unknown-plan guard) and the
 * decorator's metadata write that the global PlanGuard reads.
 */

import { RealtyPlan } from '@prisma/client';
import { Reflector } from '@nestjs/core';

import {
  DEFAULT_PLAN,
  OVERAGE_RATE_PAISE,
  PLAN_DEFINITIONS,
  planDefinition,
} from './billing.constants';
import { PlanLimit, PLAN_LIMIT_RESOURCE } from './plan.decorator';

describe('billing.constants', () => {
  it('defaults new businesses to the SOLO tier', () => {
    expect(DEFAULT_PLAN).toBe(RealtyPlan.SOLO);
  });

  it('charges ₹8 (800 paise) per overage lead', () => {
    expect(OVERAGE_RATE_PAISE).toBe(800);
  });

  it('gates the exchange to TEAM and DEVELOPER only', () => {
    expect(PLAN_DEFINITIONS[RealtyPlan.SOLO].exchangeEnabled).toBe(false);
    expect(PLAN_DEFINITIONS[RealtyPlan.TEAM].exchangeEnabled).toBe(true);
    expect(PLAN_DEFINITIONS[RealtyPlan.DEVELOPER].exchangeEnabled).toBe(true);
  });

  it('gives DEVELOPER unlimited leads and seats', () => {
    expect(PLAN_DEFINITIONS[RealtyPlan.DEVELOPER].monthlyLeadLimit).toBeNull();
    expect(PLAN_DEFINITIONS[RealtyPlan.DEVELOPER].seatLimit).toBeNull();
  });

  describe('planDefinition', () => {
    it('resolves a known plan', () => {
      expect(planDefinition(RealtyPlan.TEAM).label).toBe('Team');
    });

    it('throws on an unknown plan value', () => {
      expect(() => planDefinition('GALAXY' as RealtyPlan)).toThrow('Unknown realty plan: GALAXY');
    });
  });
});

describe('@PlanLimit decorator', () => {
  it('writes the gated resource as route metadata the guard reads', () => {
    class Ctrl {
      @PlanLimit('exchange')
      handler(): void {}
    }

    const resource = new Reflector().get(PLAN_LIMIT_RESOURCE, Ctrl.prototype.handler);
    expect(resource).toBe('exchange');
  });
});
