import { Injectable } from '@nestjs/common';
import type {
  BltcExtraction,
  BltcProfile,
  BltcSlot,
  BltcContradiction,
  BltcTurnResult,
} from '@gosumo/shared';
import { RealtyIntent } from '@gosumo/shared';
import { isBltcComplete } from '../../realty-leads/lead-scoring.util';
import {
  extractBltc,
  slotOrderForEntry,
  isSlotFilled,
  SLOT_QUESTIONS,
} from './bltc-extraction.util';

/** Inputs for one BLTC qualification turn. */
export interface BltcTurnInput {
  /** The lead's profile as it stands before this message. */
  current: BltcProfile;
  /** The buyer's latest message text. */
  text: string;
  /** The classified intent of the *first* message (drives slot ordering). */
  entryIntent?: RealtyIntent | null;
  /** Whether the contact is reachable (has phone, not opted out). */
  reachable?: boolean;
  /** Known project localities, used to sharpen locality extraction. */
  knownLocalities?: string[];
  /** Pre-extracted values (e.g. from the LLM) merged over the text extraction. */
  llmExtraction?: BltcExtraction;
}

/**
 * BltcExtractorService — the conversational qualification brain (blueprint §16.2).
 *
 * For each turn it: extracts BLTC opportunistically, merges non-conflicting
 * values (never silently overwriting a filled slot — conflicts are surfaced as
 * contradictions), and decides the single next slot to ask about. A filled slot
 * is never re-asked. When all 4 core slots are filled and the contact is
 * reachable, the lead is QUALIFIED.
 *
 * All logic is pure/deterministic so it can be exhaustively unit-tested and run
 * inside the sub-30-second response budget.
 */
@Injectable()
export class BltcExtractorService {
  /** Extract BLTC candidates from a message (deterministic pre-pass). */
  extract(text: string, knownLocalities: string[] = []): BltcExtraction {
    return extractBltc(text, knownLocalities);
  }

  /**
   * Run one qualification turn: extract → merge (surfacing contradictions) →
   * pick the next question. The LLM's extraction, when provided, is merged over
   * the deterministic one (the model sees nuance the regexes miss).
   */
  runTurn(input: BltcTurnInput): BltcTurnResult {
    const textExtraction = this.extract(input.text, input.knownLocalities ?? []);
    const extraction = this.mergeExtractions(textExtraction, input.llmExtraction);

    const { profile, filledThisTurn, contradictions } = this.mergeIntoProfile(
      input.current,
      extraction,
    );

    const order = slotOrderForEntry(input.entryIntent ?? null);
    const nextSlotToAsk = order.find((slot) => !isSlotFilled(profile, slot)) ?? null;

    const bltcComplete = isBltcComplete(profile);
    const qualified = bltcComplete && input.reachable === true;

    return {
      profile,
      filledThisTurn,
      contradictions,
      nextSlotToAsk,
      nextQuestion: nextSlotToAsk ? SLOT_QUESTIONS[nextSlotToAsk] : null,
      bltcComplete,
      qualified,
    };
  }

  /** Which core slots are still UNKNOWN, in the entry-adapted ask order. */
  unknownSlots(profile: BltcProfile, entryIntent?: RealtyIntent | null): BltcSlot[] {
    return slotOrderForEntry(entryIntent ?? null).filter((s) => !isSlotFilled(profile, s));
  }

  // ─────────────────────────────────────────────
  // Merge — never silently overwrite a filled slot
  // ─────────────────────────────────────────────

  private mergeIntoProfile(
    current: BltcProfile,
    incoming: BltcExtraction,
  ): { profile: BltcProfile; filledThisTurn: string[]; contradictions: BltcContradiction[] } {
    const profile: BltcProfile = { ...current, localities: [...current.localities] };
    const filledThisTurn: string[] = [];
    const contradictions: BltcContradiction[] = [];

    const scalar = <K extends keyof BltcProfile>(
      slot: K,
      value: BltcProfile[K] | undefined,
    ): void => {
      if (value === undefined || value === null) return;
      const existing = current[slot];
      if (existing == null) {
        profile[slot] = value;
        filledThisTurn.push(String(slot));
      } else if (existing !== value) {
        contradictions.push({ slot: String(slot), existing, incoming: value });
      }
    };

    scalar('budgetMinPaise', incoming.budgetMinPaise ?? undefined);
    scalar('budgetMaxPaise', incoming.budgetMaxPaise ?? undefined);
    scalar('timelineMonths', incoming.timelineMonths ?? undefined);
    scalar('config', incoming.config ?? undefined);
    scalar('purpose', incoming.purpose ?? undefined);
    scalar('financing', incoming.financing ?? undefined);

    // Localities merge additively; a genuinely different set is a contradiction
    // only when the existing set is non-empty and shares nothing with incoming.
    if (incoming.localities && incoming.localities.length > 0) {
      if (current.localities.length === 0) {
        profile.localities = dedupe(incoming.localities);
        filledThisTurn.push('localities');
      } else {
        const merged = dedupe([...current.localities, ...incoming.localities]);
        const overlap = incoming.localities.some((l) =>
          current.localities.some((c) => c.toLowerCase() === l.toLowerCase()),
        );
        if (!overlap) {
          contradictions.push({
            slot: 'localities',
            existing: current.localities,
            incoming: incoming.localities,
          });
        }
        // Additive interest is not a conflict — keep the union either way.
        profile.localities = merged;
      }
    }

    return { profile, filledThisTurn, contradictions };
  }

  /** LLM extraction wins per-slot where present; text extraction fills the rest. */
  private mergeExtractions(base: BltcExtraction, over?: BltcExtraction): BltcExtraction {
    if (!over) return base;
    const merged: BltcExtraction = { ...base };
    for (const key of Object.keys(over) as (keyof BltcExtraction)[]) {
      const v = over[key];
      if (v !== undefined && v !== null) {
        (merged[key] as unknown) = v;
      }
    }
    return merged;
  }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}
