import { Injectable } from '@nestjs/common';
import type { BltcProfile, LeadPurposeValue, FinancingStatusValue } from '@gosumo/shared';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import {
  validateBltcProfile,
  validateBltcMerge,
  BltcContradictionResult,
} from './bltc-contradiction.util';

/** Loosely-typed BLTC input (e.g. from a DTO) before normalization. */
export type BltcProfileInput = Partial<{
  budgetMinPaise: number | null;
  budgetMaxPaise: number | null;
  localities: string[];
  timelineMonths: number | null;
  config: string | null;
  purpose: string | null;
  financing: string | null;
}>;

/** Coerce a loose input into a full BLTC profile (unknown slots → null/[]). */
export function toBltcProfile(input: BltcProfileInput): BltcProfile {
  return {
    budgetMinPaise: input.budgetMinPaise ?? null,
    budgetMaxPaise: input.budgetMaxPaise ?? null,
    localities: input.localities ?? [],
    timelineMonths: input.timelineMonths ?? null,
    config: input.config ?? null,
    purpose: (input.purpose ?? null) as LeadPurposeValue | null,
    financing: (input.financing ?? null) as FinancingStatusValue | null,
  };
}

/**
 * RealtyContradictionService — the Phase-7 entry point for BLTC data-consistency
 * validation. Thin wrapper over the pure `bltc-contradiction.util` that adds the
 * tenant-scoped lead read, so the broker console (and a nightly consistency
 * sweep) can validate a stored lead's requirement profile.
 */
@Injectable()
export class RealtyContradictionService {
  constructor(private readonly leads: RealtyLeadsService) {}

  /** Validate an arbitrary supplied BLTC profile's internal consistency. */
  validateProfile(input: BltcProfileInput): BltcContradictionResult {
    return validateBltcProfile(toBltcProfile(input));
  }

  /** Validate an incoming partial update against a supplied existing profile. */
  validateMerge(
    existing: BltcProfile,
    incoming: Partial<BltcProfile>,
  ): BltcContradictionResult {
    return validateBltcMerge(existing, incoming);
  }

  /** Validate a stored lead's BLTC profile (tenant-scoped). */
  async validateLead(
    businessId: string,
    leadId: string,
  ): Promise<BltcContradictionResult> {
    const lead = await this.leads.getLead(businessId, leadId);
    return validateBltcProfile(lead.bltc);
  }
}
