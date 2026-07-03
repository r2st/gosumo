import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RealtyIntent,
  LeadPurpose,
  FinancingStatus,
  generateId,
  generateCorrelationId,
} from '@gosumo/shared';
import type {
  BltcProfile,
  BltcContradiction,
  RealtyConfidence,
  RealtyGroundedResponse,
  RealtyAiTurnCompletedEvent,
} from '@gosumo/shared';
import { LlmClientService, LlmUnavailableError } from '../pipeline/llm-client.service';
import { GuardrailsService } from '../safety/guardrails.service';
import { countFilledCoreSlots } from '../../realty-leads/lead-scoring.util';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import {
  RealtyInventoryService,
  UnitResponseDto,
} from '../../realty-inventory/realty-inventory.service';
import { RealtyIntentClassifierService } from './realty-intent-classifier.service';
import { BltcExtractorService } from './bltc-extractor.service';
import {
  RealtyGuardrailsService,
  RealtyGrounding,
  RealtyGuardResult,
} from './realty-guardrails.service';
import { RealtyResponseParserService } from './realty-response.parser';
import { RealtyAuditService } from './realty-audit.service';
import { computeRealtyConfidence } from './realty-confidence.util';
import {
  buildRealtySystemPrompt,
  buildRealtyUserPrompt,
  ProjectFactSheet,
  RealtyPromptVars,
} from './realty-prompt';
import { REALTY_INTENT_MODEL } from './realty-intent.constants';
import { RealtyTurnDto } from './dto';

/** The outcome of one grounded realty AI turn. */
export interface RealtyDecision {
  routeMode: RealtyConfidence['mode'];
  intent: RealtyIntent;
  /** The message to send/draft (may be softened or null on escalation). */
  responseText: string | null;
  confidence: RealtyConfidence;
  bltc: BltcProfile;
  contradictions: BltcContradiction[];
  nextQuestion: string | null;
  qualified: boolean;
  matchedUnitIds: string[];
  guardViolations: string[];
  escalationReason: string | null;
  correlationId: string;
}

const CONFIRMING_FALLBACK =
  "Let me confirm the latest availability and details with our team and get right back to you.";
const ESCALATION_HOLDING =
  "Thanks — let me get the right person from our team to help you with this. They'll be in touch shortly.";

/**
 * RealtyAiService — the realty AI loop orchestrator (blueprint §16).
 *
 * READ  : classify intent, extract BLTC, load lead + verified inventory grounding.
 * DECIDE: assemble the grounded prompt, generate, parse, run the realty hard
 *         rules and confidence routing.
 * ACT   : persist BLTC, record every decision to append-only audit_logs, and
 *         return a routed decision (AUTO / DRAFT / GUIDED / ESCALATE).
 *
 * The loop never invents facts: anything the guardrails cannot ground blocks an
 * autonomous send and hands off to a human.
 */
@Injectable()
export class RealtyAiService {
  private readonly logger = new Logger(RealtyAiService.name);

  constructor(
    private readonly classifier: RealtyIntentClassifierService,
    private readonly extractor: BltcExtractorService,
    private readonly guardrails: RealtyGuardrailsService,
    private readonly baseGuardrails: GuardrailsService,
    private readonly parser: RealtyResponseParserService,
    private readonly llm: LlmClientService,
    private readonly leads: RealtyLeadsService,
    private readonly inventory: RealtyInventoryService,
    private readonly audit: RealtyAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async processTurn(businessId: string, dto: RealtyTurnDto): Promise<RealtyDecision> {
    const traceId = dto.correlationId ?? generateCorrelationId();
    const text = dto.messageText;

    // ── READ ──────────────────────────────────
    const lead = await this.leads.getLead(businessId, dto.leadId);
    const classification = await this.classifier.classify(text);
    const intent = classification.intent;

    const safety = this.baseGuardrails.evaluate(text);
    const reachable = Boolean(lead.whatsappPhone) && !lead.optOut;

    // BLTC extraction + qualification turn (deterministic).
    const turn = this.extractor.runTurn({
      current: lead.bltc,
      text,
      entryIntent: intent,
      reachable,
    });

    // Persist the merged BLTC authoritatively (also emits qualified/hot).
    const persisted = await this.persistBltc(businessId, dto.leadId, turn.profile).catch(
      (err: unknown) => {
        this.logger.warn(
          `BLTC persist failed for lead ${dto.leadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      },
    );
    const profile = persisted?.lead.bltc ?? turn.profile;
    const contradictions = persisted?.contradictions ?? turn.contradictions;

    // Grounding — verified inventory matched to this lead.
    const { factSheets, grounding } = await this.loadGrounding(businessId, dto.leadId, lead.bltc, lead.optOut);
    const matchedUnitIds = grounding.freshAvailableUnitIds;

    // ── DECIDE ────────────────────────────────
    let grounded: RealtyGroundedResponse | null = null;
    if (!safety.jailbreakDetected && !lead.optOut) {
      grounded = await this.generate(
        dto,
        text,
        intent,
        profile,
        turn.nextQuestion,
        factSheets,
        lead.name,
        traceId,
      );
    }

    // Realty hard rules over the proposed response.
    const guard = this.guardrails.evaluate(
      {
        intent,
        responseText: grounded?.responseText ?? null,
        actions: grounded?.actions ?? [],
      },
      grounding.guardrail,
    );

    const confidence = computeRealtyConfidence({
      intent,
      matchedUnitCount: matchedUnitIds.length,
      verifiedSheetPresent: factSheets.some((f) => f.reraNumber != null || f.units.length > 0),
      bltcSlotsFilled: countFilledCoreSlots(profile),
      ragChunkCount: dto.playbookChunks?.length ?? 0,
      guard,
    });

    // ── ACT ───────────────────────────────────
    const { routeMode, responseText, escalationReason } = this.resolveOutcome(
      confidence,
      guard,
      grounded,
      safety.jailbreakDetected,
      lead.optOut,
      turn.nextQuestion,
    );

    await this.audit.record({
      businessId,
      leadId: dto.leadId,
      conversationId: dto.conversationId ?? lead.conversationId,
      routeMode,
      intent,
      confidence: confidence.finalScore,
      responseText,
      violations: guard.violations.map((v) => v.code),
      actions: grounded?.actions ?? [],
      correlationId: traceId,
    });

    const turnEvent: RealtyAiTurnCompletedEvent = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: traceId,
      type: 'realty.ai.turn_completed',
      leadId: dto.leadId,
      conversationId: dto.conversationId ?? lead.conversationId ?? undefined,
      intent,
      routeMode,
      confidence: confidence.finalScore,
      violations: guard.violations.map((v) => v.code),
      blockingViolations: guard.violations.filter((v) => v.severity === 'BLOCK').map((v) => v.code),
    };
    this.eventEmitter.emit('realty.ai.turn_completed', turnEvent);

    this.logger.log(
      `[${traceId}] Realty turn lead=${dto.leadId} intent=${intent} → ${routeMode} (confidence ${confidence.finalScore})`,
    );

    return {
      routeMode,
      intent,
      responseText,
      confidence,
      bltc: profile,
      contradictions,
      nextQuestion: turn.nextQuestion,
      qualified: turn.qualified,
      matchedUnitIds,
      guardViolations: guard.violations.map((v) => v.code),
      escalationReason,
      correlationId: traceId,
    };
  }

  /** Classify a single message (diagnostics). */
  async classify(text: string) {
    return this.classifier.classify(text);
  }

  // ─────────────────────────────────────────────
  // Generation
  // ─────────────────────────────────────────────

  private async generate(
    dto: RealtyTurnDto,
    text: string,
    intent: RealtyIntent,
    profile: BltcProfile,
    nextQuestion: string | null,
    factSheets: ProjectFactSheet[],
    leadName: string | null,
    traceId: string,
  ): Promise<RealtyGroundedResponse | null> {
    try {
      const vars: RealtyPromptVars = {
        businessName: 'our brokerage',
        brokerName: null,
        city: 'your city',
        reraRequiredOnOutbound: factSheets.some((f) => f.reraNumber != null),
        matchedFactSheets: factSheets,
        leadName,
        bltc: profile,
        nextBltcQuestion: nextQuestion,
        transcript: [],
        playbookChunks: dto.playbookChunks ?? [],
        calendarSnapshot: dto.calendarSnapshot ?? null,
        templateWindow: {
          serviceWindowOpen: dto.serviceWindowOpen ?? true,
          optedOut: false,
        },
        detectedLanguage: 'auto',
      };

      const completion = await this.llm.complete({
        system: buildRealtySystemPrompt(vars),
        user: buildRealtyUserPrompt(text),
        model: REALTY_INTENT_MODEL[intent],
        maxTokens: 1024,
        temperature: 0.3,
      });

      const parsed = this.parser.parse(completion.text, intent);
      if (!parsed) {
        this.logger.warn(`[${traceId}] Realty response parse failed — escalating`);
      }
      return parsed;
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        this.logger.error(`[${traceId}] LLM unavailable — escalating: ${err.message}`);
      } else {
        this.logger.error(
          `[${traceId}] Realty generation error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Outcome resolution
  // ─────────────────────────────────────────────

  private resolveOutcome(
    confidence: RealtyConfidence,
    guard: RealtyGuardResult,
    grounded: RealtyGroundedResponse | null,
    jailbreak: boolean,
    optedOut: boolean,
    nextQuestion: string | null,
  ): { routeMode: RealtyConfidence['mode']; responseText: string | null; escalationReason: string | null } {
    // Absolute blocks first.
    if (optedOut) {
      return { routeMode: 'ESCALATE', responseText: null, escalationReason: 'Lead has opted out — no send permitted' };
    }
    if (jailbreak) {
      return { routeMode: 'ESCALATE', responseText: ESCALATION_HOLDING, escalationReason: 'Prompt-injection attempt detected' };
    }
    if (!grounded) {
      return { routeMode: 'ESCALATE', responseText: ESCALATION_HOLDING, escalationReason: 'AI could not generate a valid grounded response' };
    }
    if (guard.mustEscalate) {
      return {
        routeMode: 'ESCALATE',
        responseText: ESCALATION_HOLDING,
        escalationReason: guard.violations.map((v) => v.reason).join('; '),
      };
    }

    // Salvageable: stale availability → soften to a "confirming" reply, cap band.
    let responseText = grounded.responseText ?? nextQuestion ?? CONFIRMING_FALLBACK;
    if (guard.rewriteToConfirming) {
      responseText = CONFIRMING_FALLBACK;
    }

    if (confidence.mode === 'ESCALATE') {
      return { routeMode: 'ESCALATE', responseText: ESCALATION_HOLDING, escalationReason: grounded.escalationReason ?? 'Low confidence — human review required' };
    }
    return { routeMode: confidence.mode, responseText, escalationReason: grounded.escalationReason ?? null };
  }

  // ─────────────────────────────────────────────
  // Persistence + grounding
  // ─────────────────────────────────────────────

  private async persistBltc(businessId: string, leadId: string, profile: BltcProfile) {
    return this.leads.applyBltcUpdate(businessId, leadId, {
      budgetMinPaise: profile.budgetMinPaise ?? undefined,
      budgetMaxPaise: profile.budgetMaxPaise ?? undefined,
      localities: profile.localities.length ? profile.localities : undefined,
      timelineMonths: profile.timelineMonths ?? undefined,
      config: profile.config ?? undefined,
      purpose: (profile.purpose as LeadPurpose | null) ?? undefined,
      financing: (profile.financing as FinancingStatus | null) ?? undefined,
      force: true, // profile already reflects the contradiction-safe merge
    });
  }

  /** Load verified inventory grounding for a lead's BLTC. Best-effort. */
  private async loadGrounding(
    businessId: string,
    leadId: string,
    bltc: BltcProfile,
    optedOut: boolean,
  ): Promise<{ factSheets: ProjectFactSheet[]; grounding: GroundingBundle }> {
    const empty: GroundingBundle = {
      freshAvailableUnitIds: [],
      guardrail: {
        verifiedPricesPaise: [],
        leadBudgetPaise: this.budgetBounds(bltc),
        hasFreshAvailableUnit: false,
        sheetReraNumbers: [],
        leadOptedOut: optedOut,
        otherBuyerIdentifiers: [],
      },
    };

    try {
      const matches = await this.inventory.matchForLead(businessId, leadId, 3);
      if (matches.length === 0) return { factSheets: [], grounding: empty };

      const projectIds = [...new Set(matches.map((m) => m.projectId))];
      const factSheets: ProjectFactSheet[] = [];
      const verifiedPricesPaise: number[] = [];
      const freshAvailableUnitIds: string[] = [];
      const sheetReraNumbers: string[] = [];

      for (const projectId of projectIds) {
        const [project, units, assets] = await Promise.all([
          this.inventory.getProject(businessId, projectId),
          this.inventory.listUnits(businessId, projectId),
          this.inventory.listAssets(businessId, projectId).catch(() => []),
        ]);

        if (project.reraNumber) sheetReraNumbers.push(project.reraNumber);
        if (project.priceBandMinPaise != null) verifiedPricesPaise.push(project.priceBandMinPaise);
        if (project.priceBandMaxPaise != null) verifiedPricesPaise.push(project.priceBandMaxPaise);

        for (const u of units) {
          verifiedPricesPaise.push(u.allInPricePaise);
          if (u.isFresh) freshAvailableUnitIds.push(u.id);
        }

        factSheets.push({
          projectName: project.name,
          developer: project.developer,
          locality: project.locality,
          reraNumber: project.reraNumber,
          status: project.status,
          possession: project.possessionDate ? project.possessionDate.toISOString().slice(0, 10) : null,
          amenities: project.amenities,
          units: units.map((u: UnitResponseDto) => ({
            config: u.config,
            allInPriceLabel: paiseLabel(u.allInPricePaise),
            carpetSqft: u.carpetSqft,
            availability: u.availability,
            availabilityAssertable: u.isFresh,
          })),
          availableAssets: assets.filter((a) => a.isCurrent).map((a) => a.type),
        });
      }

      return {
        factSheets,
        grounding: {
          freshAvailableUnitIds,
          guardrail: {
            verifiedPricesPaise,
            leadBudgetPaise: this.budgetBounds(bltc),
            hasFreshAvailableUnit: freshAvailableUnitIds.length > 0,
            sheetReraNumbers,
            leadOptedOut: optedOut,
            otherBuyerIdentifiers: [],
          },
        },
      };
    } catch (err) {
      this.logger.warn(
        `Grounding load failed for lead ${leadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { factSheets: [], grounding: empty };
    }
  }

  private budgetBounds(bltc: BltcProfile): number[] {
    const out: number[] = [];
    if (bltc.budgetMinPaise != null) out.push(bltc.budgetMinPaise);
    if (bltc.budgetMaxPaise != null) out.push(bltc.budgetMaxPaise);
    return out;
  }
}

/** Grounding assembled for one turn: guardrail facts + the fresh unit ids. */
interface GroundingBundle {
  freshAvailableUnitIds: string[];
  guardrail: RealtyGrounding;
}

function paiseLabel(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 1e7) return `₹${Math.round((rupees / 1e7) * 10) / 10} Cr`;
  if (rupees >= 1e5) return `₹${Math.round((rupees / 1e5) * 10) / 10} L`;
  return `₹${Math.round(rupees)}`;
}
