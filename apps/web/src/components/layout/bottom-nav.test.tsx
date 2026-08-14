import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let pathname: string | null = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { BottomNav } from './bottom-nav';

function renderNav(onMore = vi.fn()) {
  const view = render(<BottomNav onMore={onMore} />);
  return { ...view, onMore };
}

/** The tab currently marked with aria-current, which is what a screen reader announces. */
function currentTab() {
  return screen.getAllByRole('link').find((el) => el.getAttribute('aria-current') === 'page');
}

describe('BottomNav', () => {
  beforeEach(() => {
    pathname = '/dashboard';
  });

  it('renders the five most-used destinations', () => {
    renderNav();
    for (const label of ['Dashboard', 'Leads', 'Chats', 'Inventory', 'More']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders four links plus one button', () => {
    // "More" must be a button, not a link — it opens the sidebar rather than
    // navigating, and a link would push a bogus "#more" history entry.
    renderNav();
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('marks the current tab with aria-current', () => {
    pathname = '/leads';
    renderNav();
    expect(currentTab()).toHaveAttribute('href', '/leads');
  });

  it('keeps the parent tab current on a nested route', () => {
    pathname = '/leads/abc-123';
    renderNav();
    expect(currentTab()).toHaveAttribute('href', '/leads');
  });

  it('does not mark a route that merely shares a prefix', () => {
    pathname = '/inventoryx';
    renderNav();
    expect(currentTab()).toBeUndefined();
  });

  it('marks nothing current on a route outside the tab bar', () => {
    pathname = '/settings/billing';
    renderNav();
    expect(currentTab()).toBeUndefined();
  });

  it('never marks "More" as current, even at its placeholder href', () => {
    pathname = '#more';
    renderNav();
    expect(currentTab()).toBeUndefined();
  });

  it('survives a null pathname', () => {
    pathname = null;
    expect(() => renderNav()).not.toThrow();
    expect(currentTab()).toBeUndefined();
  });

  it('opens the sidebar from the More tab', () => {
    const { onMore } = renderNav();
    fireEvent.click(screen.getByLabelText('Open menu'));
    expect(onMore).toHaveBeenCalledOnce();
  });

  it('is labelled as primary navigation', () => {
    renderNav();
    expect(screen.getByRole('navigation')).toHaveAttribute('aria-label', 'Primary');
  });

  it('is hidden from md up, so it never doubles the sidebar on desktop', () => {
    renderNav();
    expect(screen.getByRole('navigation').className).toContain('md:hidden');
  });

  it('pads for the iOS home indicator', () => {
    // Without safe-area padding the tab labels sit under the home bar on any
    // notched iPhone, which is most of the field sales team.
    renderNav();
    expect(screen.getByRole('navigation')).toHaveStyle({
      paddingBottom: 'env(safe-area-inset-bottom)',
    });
  });
});
