import { ConfidenceMode, IntentType } from '@gosumo/shared';
import { ActionRouterService } from './action-router.service';
import { ScoredConfidence } from './confidence-calculator.service';

function scored(partial: Partial<ScoredConfidence>): ScoredConfidence {
  return {
    dataAvailability: 1,
    policyClarity: 1,
    finalScore: 1,
    mode: ConfidenceMode.AUTO_PILOT,
    overrides: [],
    requiresEscalation: false,
    ...partial,
  };
}

describe('ActionRouterService', () => {
  let router: ActionRouterService;

  beforeEach(() => {
    router = new ActionRouterService();
  });

  it('AUTO_PILOT → auto-execute with no task and no holding message', () => {
    const decision = router.route(scored({ mode: ConfidenceMode.AUTO_PILOT }), IntentType.BOOKING);
    expect(decision.action).toBe('AUTO_EXECUTE');
    expect(decision.createsTask).toBe(false);
    expect(decision.holdingMessage).toBeNull();
  });

  it('DRAFT → draft review with a task and a holding message', () => {
    const decision = router.route(
      scored({ mode: ConfidenceMode.DRAFT, finalScore: 0.8 }),
      IntentType.BOOKING,
    );
    expect(decision.action).toBe('DRAFT_REVIEW');
    expect(decision.createsTask).toBe(true);
    expect(decision.holdingMessage).toBeTruthy();
  });

  it('GUIDED → clarifying question with monitoring task', () => {
    const decision = router.route(
      scored({ mode: ConfidenceMode.GUIDED, finalScore: 0.6 }),
      IntentType.PRICING,
    );
    expect(decision.action).toBe('GUIDED');
    expect(decision.needsClarification).toBe(true);
  });

  it('ESCALATION → escalate', () => {
    const decision = router.route(
      scored({ mode: ConfidenceMode.ESCALATION, finalScore: 0.2, requiresEscalation: true }),
      IntentType.COMPLAINT,
    );
    expect(decision.action).toBe('ESCALATE');
    expect(decision.holdingMessage).toBeTruthy();
  });

  it('an escalation-forcing override diverts a DRAFT-band score to escalation', () => {
    const decision = router.route(
      scored({
        mode: ConfidenceMode.DRAFT,
        finalScore: 0.8,
        requiresEscalation: true,
        overrides: [{ code: 'customer_mentions_legal_action', reason: 'legal', penalty: 0.7 }],
      }),
      IntentType.COMPLAINT,
    );
    expect(decision.action).toBe('ESCALATE');
    expect(decision.urgency).toBe('CRITICAL');
  });

  it('derives HIGH urgency for an explicit human request', () => {
    const decision = router.route(
      scored({
        mode: ConfidenceMode.ESCALATION,
        finalScore: 0.1,
        requiresEscalation: true,
        overrides: [{ code: 'explicit_human_request', reason: 'human', penalty: 0.5 }],
      }),
      IntentType.GENERAL_INQUIRY,
    );
    expect(decision.urgency).toBe('HIGH');
  });

  it('derives LOW urgency for plain low confidence', () => {
    const decision = router.route(
      scored({ mode: ConfidenceMode.ESCALATION, finalScore: 0.4, requiresEscalation: true }),
      IntentType.GENERAL_INQUIRY,
    );
    expect(decision.urgency).toBe('LOW');
  });
});
