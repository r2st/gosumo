/**
 * A VIEWER is offered no write controls.
 *
 * R23 made VIEWER read-only on the API: the RolesGuard refuses any
 * POST/PUT/PATCH/DELETE that carries no `@Roles()`, so every "Confirm order",
 * "Refund", "Approve" and "Save" button in the dashboard came back 403 for a
 * VIEWER while still being rendered. This suite covers one surface per tier
 * and asserts both directions — hidden for VIEWER, present for the lowest role
 * the API actually admits. Asserting only the first half would pass just as
 * well if the control had been deleted outright.
 *
 * The tier boundaries themselves are covered in src/lib/permissions.test.ts;
 * this file is about the surfaces wiring up to them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Role } from '@/lib/feature-types';

let currentRole: Role | null = 'VIEWER';

const authValue = () => ({
  status: 'authenticated' as const,
  user:
    currentRole === null
      ? null
      : {
          id: 'u1',
          email: 'me@acme.in',
          name: 'Me',
          role: currentRole,
          businessId: 'b1',
          twoFactorEnabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
  business: null,
});

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue(),
  useOptionalAuth: () => authValue(),
}));

const noop = { mutate: vi.fn(), isPending: false, isError: false, isSuccess: false };

// ── Orders ──────────────────────────────────────────────────────────────────
vi.mock('@/hooks/use-orders', () => ({
  useConfirmOrder: () => noop,
  useFulfillOrder: () => noop,
  useUpdateOrderStatus: () => noop,
  useCancelOrder: () => noop,
}));

// ── Billing ─────────────────────────────────────────────────────────────────
vi.mock('@/hooks/use-settings', () => ({
  useSubscription: () => ({
    data: {
      plan: 'STARTER',
      status: 'ACTIVE',
      priceMonthlyPaise: 99900,
      trialEndsAt: null,
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      usage: [],
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useUpgradePlan: () => noop,
}));

// ── HITL review ─────────────────────────────────────────────────────────────
vi.mock('@/hooks/use-queries', () => ({
  useApproveTask: () => noop,
  useRejectTask: () => noop,
}));

const { OrderStatusControl } = await import('@/components/orders/order-status-control');
const { default: BillingPage } = await import('@/app/(dashboard)/settings/billing/page');
const { AiDraftPanel } = await import('@/components/conversations/ai-draft-panel');

const order = {
  id: 'order-1',
  businessId: 'b1',
  orderNumber: 'ORD-1',
  status: 'DRAFT',
  items: [],
  subtotalPaise: 100000,
  totalPaise: 100000,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as never;

const task = {
  id: 'task-1',
  conversationId: 'conv-1',
  aiDraft: 'Thanks for reaching out! Our 2BHK units start at ₹85L.',
  confidence: 0.82,
  priority: 'MEDIUM',
  status: 'PENDING',
  createdAt: '2026-01-01T00:00:00.000Z',
} as never;

function renderAs(role: Role | null, ui: React.ReactElement) {
  currentRole = role;
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = 'VIEWER';
});

// ════════════════════════════════════════════════════════════════════════════
// The STAFF+ default: undecorated writes
// ════════════════════════════════════════════════════════════════════════════

describe('order status controls (undecorated writes — STAFF+)', () => {
  it('offers a VIEWER nothing', () => {
    renderAs('VIEWER', <OrderStatusControl order={order} />);
    expect(screen.queryByRole('button', { name: /confirm order/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('offers STAFF the transitions the API admits', () => {
    renderAs('STAFF', <OrderStatusControl order={order} />);
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeTruthy();
  });
});

describe('AI draft review (undecorated writes — STAFF+)', () => {
  it('shows a VIEWER the draft but no approve or reject', () => {
    renderAs('VIEWER', <AiDraftPanel task={task} />);
    // The draft itself is readable — only actioning it is gated.
    expect(screen.getByText(/2BHK units start/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('lets STAFF approve or reject', () => {
    renderAs('STAFF', <AiDraftPanel task={task} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The OWNER tier: @Roles(OWNER)
// ════════════════════════════════════════════════════════════════════════════

describe('billing (POST /billing/upgrade — @Roles(OWNER))', () => {
  it.each(['VIEWER', 'STAFF', 'MANAGER'] as Role[])('offers %s no plan change', (role) => {
    renderAs(role, <BillingPage />);
    expect(screen.queryByRole('button', { name: /upgrade plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^upgrade$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /switch/i })).toBeNull();
  });

  it('lets an OWNER change the plan', () => {
    renderAs('OWNER', <BillingPage />);
    expect(screen.getByRole('button', { name: /upgrade plan/i })).toBeTruthy();
  });

  it('still shows every role the current plan and its usage', () => {
    // Reads are deliberately untouched by the guard — a MANAGER who cannot
    // change the plan can still see what it is.
    renderAs('MANAGER', <BillingPage />);
    // Named in both the current-plan header and its card in the plan grid.
    expect(screen.getAllByText(/starter/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/\/month/)).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Degenerate sessions
// ════════════════════════════════════════════════════════════════════════════

describe('an unknown or absent role', () => {
  it('is treated as read-only rather than crashing', () => {
    // A stale bundle against a newer API can carry a role this build has never
    // heard of. It must rank below VIEWER and see no write controls.
    currentRole = 'ARCHITECT' as Role;
    render(<OrderStatusControl order={order} />);
    expect(screen.queryByRole('button', { name: /confirm order/i })).toBeNull();
  });

  it('hides controls while the session is still loading', () => {
    // Rendering the button first and removing it once the role arrives would
    // flash a control the user may not be entitled to.
    renderAs(null, <OrderStatusControl order={order} />);
    expect(screen.queryByRole('button', { name: /confirm order/i })).toBeNull();
  });
});
