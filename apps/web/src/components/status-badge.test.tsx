/**
 * StatusBadge.
 *
 * A `Record<string, BadgeTone>` lookup with a `?? 'neutral'` fallback. The map
 * is keyed by `string`, not by a union, so nothing at compile time ties it to
 * the enums the API actually sends — a status the backend adds lands on the
 * fallback silently. That path has to render the value legibly rather than an
 * empty or broken badge, because this component labels rows across the inbox,
 * orders, payments and bookings.
 *
 * The tone assertions are on the class the tone resolves to (see ui/badge.tsx),
 * since the tone itself is not exposed in the DOM.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge';

/** The class `ui/badge.tsx` renders for each tone. */
const TONE_CLASS = {
  neutral: 'bg-muted',
  primary: 'bg-accent',
  success: 'bg-emerald-500/15',
  warning: 'bg-amber-500/15',
  danger: 'bg-rose-500/15',
  info: 'bg-sky-500/15',
} as const;

function toneClassOf(value: string): string {
  const { unmount } = render(<StatusBadge value={value} />);
  const cls = screen.getByText(/./).className;
  unmount();
  return cls;
}

describe('StatusBadge', () => {
  it.each([
    // Conversation
    ['OPEN', 'info'],
    ['PENDING_HUMAN', 'warning'],
    ['RESOLVED', 'success'],
    ['ESCALATED', 'danger'],
    ['BOT_HANDLING', 'primary'],
    ['SNOOZED', 'neutral'],
    // Priority
    ['URGENT', 'danger'],
    ['LOW', 'neutral'],
    // Orders
    ['PENDING_PAYMENT', 'warning'],
    ['DELIVERED', 'success'],
    ['CANCELLED', 'danger'],
    // Payments
    ['CAPTURED', 'success'],
    ['FAILED', 'danger'],
    // Sentiment
    ['VERY_NEGATIVE', 'danger'],
    ['VERY_POSITIVE', 'success'],
  ])('renders %s with the %s tone', (value, tone) => {
    expect(toneClassOf(value)).toContain(TONE_CLASS[tone as keyof typeof TONE_CLASS]);
  });

  it('humanizes the enum for display', () => {
    render(<StatusBadge value="READY_FOR_PICKUP" />);
    expect(screen.getByText('Ready For Pickup')).toBeInTheDocument();
  });

  it('falls back to neutral for a status the map has no entry for', () => {
    // The map is keyed by plain string, so a status the API adds compiles fine
    // and lands here. It must still read as a badge, not as an unstyled span.
    render(<StatusBadge value="AWAITING_KYC" />);
    const badge = screen.getByText('Awaiting Kyc');
    expect(badge.className).toContain(TONE_CLASS.neutral);
    expect(badge.className).toContain('rounded-full');
  });

  it('renders the em-dash placeholder for an empty status', () => {
    // humanizeEnum('') returns '—'; an empty badge would look like a bug.
    render(<StatusBadge value="" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('merges a caller className onto the badge', () => {
    render(<StatusBadge value="OPEN" className="ml-2" />);
    const badge = screen.getByText('Open');
    expect(badge.className).toContain('ml-2');
    expect(badge.className).toContain(TONE_CLASS.info);
  });
});
