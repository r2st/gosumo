import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const useChannels = vi.fn();
const useTeam = vi.fn();
const useDashboardMetrics = vi.fn();
vi.mock('@/hooks/use-settings', () => ({ useChannels: () => useChannels(), useTeam: () => useTeam() }));
vi.mock('@/hooks/use-queries', () => ({ useDashboardMetrics: () => useDashboardMetrics() }));

import { GettingStartedGuide, buildGuideSteps, markSupportLinkShared } from './getting-started-guide';

function setup({ connected = false, total = 0, outbound = 0, members = 1 } = {}) {
  useChannels.mockReturnValue({
    isLoading: false,
    data: { data: connected ? [{ id: 'c', type: 'WEB_CHAT', status: 'CONNECTED' }] : [] },
  });
  useTeam.mockReturnValue({ data: { data: Array.from({ length: members }, (_, i) => ({ id: String(i) })) } });
  useDashboardMetrics.mockReturnValue({
    isLoading: false,
    data: { conversations: { total }, messages: { outbound } },
  });
}

/** jsdom runs on an opaque origin, so `localStorage` is missing entirely. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  installLocalStorage();
  vi.clearAllMocks();
});

describe('buildGuideSteps', () => {
  it('ticks steps from the signals it is given', () => {
    const steps = buildGuideSteps({
      channelConnected: true,
      linkShared: false,
      ticketReceived: true,
      replied: false,
      teamInvited: false,
    });
    expect(steps.map((s) => s.done)).toEqual([true, false, true, false, false]);
  });
});

describe('GettingStartedGuide', () => {
  it('shows a fresh account all five steps with progress', () => {
    setup();
    render(<GettingStartedGuide />);
    expect(screen.getByText('Get started with DoAide Desk')).toBeInTheDocument();
    expect(screen.getByText(/0 of 5 done/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/settings/channels');
  });

  it('derives progress from real account state', () => {
    setup({ connected: true, total: 3, outbound: 1, members: 2 });
    render(<GettingStartedGuide />);
    expect(screen.getByText(/4 of 5 done/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  });

  it('ticks the share step when the support link is shared', () => {
    setup({ connected: true, total: 3, outbound: 1 });
    render(<GettingStartedGuide />);
    expect(screen.getByText(/3 of 5 done/)).toBeInTheDocument();
    act(() => markSupportLinkShared());
    expect(screen.getByText(/4 of 5 done/)).toBeInTheDocument();
  });

  it('disappears once everything is done', () => {
    localStorage.setItem('desk:guide:shared-link', '1');
    setup({ connected: true, total: 1, outbound: 1, members: 2 });
    const { container } = render(<GettingStartedGuide />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden after the operator dismisses it', () => {
    setup();
    const { unmount } = render(<GettingStartedGuide />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide getting started guide' }));
    expect(screen.queryByText('Get started with DoAide Desk')).not.toBeInTheDocument();
    unmount();
    render(<GettingStartedGuide />);
    expect(screen.queryByText('Get started with DoAide Desk')).not.toBeInTheDocument();
  });
});
