/**
 * Settings → Billing.
 *
 * Two things on this page can be wrong in a way that costs somebody money.
 *
 * The **"Upgrade plan" button** picks its target arithmetically —
 * `ORDER[currentIndex + 1]` — so it is one off-by-one away from selling a
 * GROWTH customer a STARTER downgrade, or from running off the end of the
 * array and posting `undefined` as a plan. Every rung of the ladder is walked
 * here, including the top one where the button must not appear at all.
 *
 * The **usage meters** divide by a limit that is `null` for unlimited plans.
 * A naive `used / limit` gives `Infinity`; a `Math.max(1, …)` guard that runs
 * on the wrong branch gives a bar that fills at one conversation. Unlimited
 * must render as words, not as a bar, and a meter at its cap must not exceed
 * 100%.
 *
 * Role handling matters too: `POST /business/subscription/upgrade` is
 * `@Roles(OWNER)`, so a MANAGER reads their plan and usage but is offered no
 * button that would only come back 403.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, SubscriptionInfo, SubscriptionPlan, UsageMeter } from '@/lib/feature-types';

function makeMeter(overrides: Partial<UsageMeter> = {}): UsageMeter {
  return {
    key: 'conversations',
    label: 'Conversations',
    used: 420,
    limit: 2000,
    unit: 'msgs',
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    plan: 'STARTER',
    status: 'ACTIVE',
    priceMonthlyPaise: 99900,
    currentPeriodEnd: '2026-09-01T00:00:00.000Z',
    usage: [makeMeter()],
    ...overrides,
  };
}

const subscription = {
  data: undefined as SubscriptionInfo | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
};

const upgrade = { mutate: vi.fn(), isPending: false };
let role: Role = 'OWNER';

vi.mock('@/hooks/use-settings', () => ({
  useSubscription: () => subscription,
  useUpgradePlan: () => upgrade,
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

import BillingPage from './page';

/**
 * The plan card for a tier, from the ladder below the "Plans" heading. Scoped
 * to that grid because the current-plan panel above it prints the same word.
 */
function planCard(plan: string): HTMLElement {
  const grid = screen.getByText('Plans').nextElementSibling as HTMLElement;
  return within(grid).getByText(plan, { selector: 'span' }).closest('div.flex-col') as HTMLElement;
}

/** What the upgrade CTA at the top of the page would buy. */
function clickUpgradeCta() {
  fireEvent.click(screen.getByRole('button', { name: /upgrade plan/i }));
  return upgrade.mutate.mock.calls[0]?.[0] as SubscriptionPlan;
}

beforeEach(() => {
  vi.clearAllMocks();
  subscription.data = makeSubscription();
  subscription.isLoading = false;
  subscription.isError = false;
  upgrade.isPending = false;
  role = 'OWNER';
  // `handleUpgrade` navigates on a checkout URL; jsdom has no navigation.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: '' },
  });
});

describe('BillingPage — query states', () => {
  it('shows the spinner while the subscription loads', () => {
    subscription.isLoading = true;
    subscription.data = undefined;

    render(<BillingPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('offers a retry when the subscription fails to load', () => {
    subscription.isError = true;
    subscription.data = undefined;

    render(<BillingPage />);
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));

    expect(subscription.refetch).toHaveBeenCalled();
  });

  it('does not render a plan ladder against a missing subscription', () => {
    subscription.data = undefined;

    render(<BillingPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade plan/i })).not.toBeInTheDocument();
  });
});

describe('BillingPage — the current plan panel', () => {
  it('renders the price in rupees rather than the paise it arrived as', () => {
    render(<BillingPage />);

    expect(screen.getByText(/₹999(\.00)?\/month/)).toBeInTheDocument();
    expect(screen.queryByText(/99900/)).not.toBeInTheDocument();
  });

  it('says "Free plan" instead of ₹0 when nothing is being charged', () => {
    subscription.data = makeSubscription({ plan: 'FREE', priceMonthlyPaise: 0 });

    render(<BillingPage />);

    expect(screen.getByText(/Free plan/)).toBeInTheDocument();
  });

  it('shows the trial end date only while the subscription is in trial', () => {
    subscription.data = makeSubscription({
      status: 'TRIAL',
      trialEndsAt: '2026-08-20T00:00:00.000Z',
    });

    render(<BillingPage />);

    expect(screen.getByText(/Trial ends/)).toBeInTheDocument();
    expect(screen.getByText('Trial')).toBeInTheDocument();
  });

  it('does not announce a trial end date on an active subscription', () => {
    // A TRIAL date left over on an upgraded account would read as "your paid
    // plan expires on…", which is a support ticket.
    subscription.data = makeSubscription({
      status: 'ACTIVE',
      trialEndsAt: '2026-08-20T00:00:00.000Z',
    });

    render(<BillingPage />);

    expect(screen.queryByText(/Trial ends/)).not.toBeInTheDocument();
    expect(screen.getByText(/Renews/)).toBeInTheDocument();
  });

  it('spells out PAST_DUE rather than showing the raw enum', () => {
    subscription.data = makeSubscription({ status: 'PAST_DUE' });

    render(<BillingPage />);

    expect(screen.getByText('Past due')).toBeInTheDocument();
    expect(screen.queryByText('PAST_DUE')).not.toBeInTheDocument();
  });

  it('title-cases a cancelled subscription', () => {
    subscription.data = makeSubscription({ status: 'CANCELLED' });

    render(<BillingPage />);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });
});

describe('BillingPage — the upgrade CTA picks the next rung, never a lower one', () => {
  it.each([
    ['FREE' as const, 'STARTER'],
    ['STARTER' as const, 'GROWTH'],
    ['GROWTH' as const, 'ENTERPRISE'],
  ])('offers %s the next tier up (%s)', (plan, expected) => {
    subscription.data = makeSubscription({ plan });

    render(<BillingPage />);

    expect(clickUpgradeCta()).toBe(expected);
  });

  it('hides the CTA entirely on the top tier instead of selling it again', () => {
    // `Math.min(index + 1, length - 1)` would otherwise resolve ENTERPRISE to
    // itself and post a no-op upgrade.
    subscription.data = makeSubscription({ plan: 'ENTERPRISE' });

    render(<BillingPage />);

    expect(screen.queryByRole('button', { name: /upgrade plan/i })).not.toBeInTheDocument();
  });

  it('redirects to the gateway when the upgrade returns a checkout URL', () => {
    render(<BillingPage />);
    clickUpgradeCta();

    const [, opts] = upgrade.mutate.mock.calls[0] as [
      SubscriptionPlan,
      { onSuccess: (r: { checkoutUrl?: string }) => void },
    ];
    opts.onSuccess({ checkoutUrl: 'https://checkout.razorpay.com/session-1' });

    expect(window.location.href).toBe('https://checkout.razorpay.com/session-1');
  });

  it('stays put when the upgrade completes without a checkout URL', () => {
    // A downgrade or an in-place plan change needs no payment page; navigating
    // to `undefined` would land the operator on /undefined.
    render(<BillingPage />);
    clickUpgradeCta();

    const [, opts] = upgrade.mutate.mock.calls[0] as [
      SubscriptionPlan,
      { onSuccess: (r: { checkoutUrl?: string }) => void },
    ];
    opts.onSuccess({});

    expect(window.location.href).toBe('');
  });
});

describe('BillingPage — the plan ladder', () => {
  it('marks the current plan and disables its button', () => {
    render(<BillingPage />);

    const card = planCard('starter');
    expect(within(card).getByText('Current')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Current plan' })).toBeDisabled();
  });

  it('labels tiers above the current plan "Upgrade" and below it "Switch"', () => {
    subscription.data = makeSubscription({ plan: 'GROWTH' });

    render(<BillingPage />);

    expect(within(planCard('enterprise')).getByRole('button')).toHaveTextContent('Upgrade');
    expect(within(planCard('starter')).getByRole('button')).toHaveTextContent('Switch');
    expect(within(planCard('free')).getByRole('button')).toHaveTextContent('Switch');
  });

  it('buys exactly the tier whose card was clicked', () => {
    render(<BillingPage />);
    fireEvent.click(within(planCard('enterprise')).getByRole('button'));

    expect(upgrade.mutate).toHaveBeenCalledWith('ENTERPRISE', expect.any(Object));
  });

  it('freezes every plan button while a change is in flight', () => {
    // Two overlapping upgrades would create two checkout sessions.
    upgrade.isPending = true;

    render(<BillingPage />);

    for (const plan of ['free', 'starter', 'growth', 'enterprise']) {
      expect(within(planCard(plan)).getByRole('button')).toBeDisabled();
    }
  });

  it('shows a per-month suffix on priced tiers but not on Free or Custom', () => {
    render(<BillingPage />);

    expect(within(planCard('starter')).getByText('/mo')).toBeInTheDocument();
    expect(within(planCard('free')).queryByText('/mo')).not.toBeInTheDocument();
    expect(within(planCard('enterprise')).queryByText('/mo')).not.toBeInTheDocument();
    expect(within(planCard('enterprise')).getByText('Custom')).toBeInTheDocument();
  });
});

describe('BillingPage — what a non-owner sees', () => {
  it.each(['MANAGER' as const, 'STAFF' as const, 'VIEWER' as const])(
    'shows a %s the plan and usage but no way to change it',
    (r) => {
      role = r;

      render(<BillingPage />);

      expect(screen.queryByRole('button', { name: /upgrade plan/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^(Upgrade|Switch|Current plan)$/ })).toBeNull();
      // …but the information is still there to read.
      expect(screen.getByText('Conversations')).toBeInTheDocument();
      expect(screen.getByText('Current')).toBeInTheDocument();
    },
  );
});

describe('BillingPage — usage meters', () => {
  /** The filled portion of a meter's bar, as a CSS width. */
  function barWidth(label: string): string | undefined {
    const block = screen.getByText(label).closest('div')?.parentElement;
    return block?.querySelector<HTMLElement>('[class*="rounded-full"] > div')?.style.width;
  }

  it('renders an unlimited meter as words, not as a bar at infinity', () => {
    subscription.data = makeSubscription({
      usage: [makeMeter({ label: 'Messages', used: 8_000, limit: null })],
    });

    render(<BillingPage />);

    expect(screen.getByText('Unlimited')).toBeInTheDocument();
    expect(barWidth('Messages')).toBeUndefined();
    // The count is still shown, just without a denominator.
    expect(screen.getByText(/8,000 msgs/)).toBeInTheDocument();
  });

  it('shows used against limit on a metered plan', () => {
    render(<BillingPage />);

    expect(screen.getByText(/420 \/ 2,000 msgs/)).toBeInTheDocument();
  });

  it('caps the bar at 100% when usage has overshot the limit', () => {
    subscription.data = makeSubscription({
      usage: [makeMeter({ label: 'Overage', used: 5000, limit: 2000 })],
    });

    render(<BillingPage />);

    expect(barWidth('Overage')).toBe('100%');
  });

  it('keeps a sliver of bar visible at zero usage', () => {
    // A 0%-wide div is invisible, and an empty meter would look like a
    // rendering failure rather than a fresh billing period.
    subscription.data = makeSubscription({
      usage: [makeMeter({ label: 'Fresh', used: 0, limit: 2000 })],
    });

    render(<BillingPage />);

    expect(barWidth('Fresh')).toBe('2%');
  });

  it('does not divide by zero on a limit of nought', () => {
    subscription.data = makeSubscription({
      usage: [makeMeter({ label: 'Blocked', used: 3, limit: 0 })],
    });

    render(<BillingPage />);

    expect(barWidth('Blocked')).toBe('100%');
  });

  it('renders every meter it is given', () => {
    subscription.data = makeSubscription({
      usage: [
        makeMeter({ key: 'a', label: 'Conversations' }),
        makeMeter({ key: 'b', label: 'AI tokens', used: 12, limit: 100, unit: 'k' }),
      ],
    });

    render(<BillingPage />);

    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(screen.getByText('AI tokens')).toBeInTheDocument();
  });

  it('says so plainly when the period has no usage recorded yet', () => {
    subscription.data = makeSubscription({ usage: [] });

    render(<BillingPage />);

    expect(screen.getByText('No usage data yet.')).toBeInTheDocument();
  });
});
