import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let pathname: string | null = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { Sidebar } from './sidebar';
import { NAV_SECTIONS, NAV_TOP } from './nav-items';
import { LanguageProvider } from '@/providers/language-provider';

function renderSidebar({ open = true, onClose = vi.fn() } = {}) {
  const view = render(
    <LanguageProvider>
      <Sidebar open={open} onClose={onClose} />
    </LanguageProvider>,
  );
  return { ...view, onClose };
}

function activeLink() {
  return screen
    .getAllByRole('link')
    .find((el) => el.className.includes('bg-accent'));
}

describe('Sidebar', () => {
  beforeEach(() => {
    pathname = '/dashboard';
  });

  it('renders every nav destination exactly once', () => {
    // A duplicated or missing route here is invisible in review but leaves a
    // whole surface unreachable from the shell.
    renderSidebar();
    const nav = screen.getByRole('navigation');
    const hrefs = Array.from(nav.querySelectorAll('a')).map((el) => el.getAttribute('href'));
    const expected = [...NAV_TOP, ...NAV_SECTIONS.flatMap((s) => s.items)].map((i) => i.href);
    expect(hrefs).toEqual(expected);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('renders each section header', () => {
    renderSidebar();
    for (const section of NAV_SECTIONS) {
      expect(screen.getByText(section.label)).toBeInTheDocument();
    }
  });

  it('marks the current route active', () => {
    pathname = '/leads';
    renderSidebar();
    expect(activeLink()).toHaveAttribute('href', '/leads');
  });

  it('keeps the parent active on a nested route', () => {
    // /leads/abc must still light up "Leads", or drilling into a record makes
    // the sidebar look like you have navigated away from the section.
    pathname = '/leads/abc-123';
    renderSidebar();
    expect(activeLink()).toHaveAttribute('href', '/leads');
  });

  it('does not treat a route that merely shares a prefix as active', () => {
    pathname = '/leadsomething';
    renderSidebar();
    expect(activeLink()).toBeUndefined();
  });

  it('marks nothing active on an unknown route', () => {
    pathname = '/nowhere';
    renderSidebar();
    expect(activeLink()).toBeUndefined();
  });

  it('survives a null pathname instead of throwing', () => {
    // `usePathname` is typed `string | null`; an unguarded `startsWith` would
    // take down the entire dashboard shell.
    pathname = null;
    expect(() => renderSidebar()).not.toThrow();
    expect(activeLink()).toBeUndefined();
  });

  it('closes when a destination is chosen, so the mobile drawer does not linger', () => {
    const { onClose } = renderSidebar();
    fireEvent.click(screen.getAllByRole('link')[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes from the explicit close button', () => {
    const onClose = vi.fn();
    renderSidebar({ onClose });
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a dismissable overlay only while open', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <LanguageProvider>
        <Sidebar open onClose={onClose} />
      </LanguageProvider>,
    );
    const overlay = container.querySelector('.bg-black\\/40');
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay as Element);
    expect(onClose).toHaveBeenCalled();

    rerender(
      <LanguageProvider>
        <Sidebar open={false} onClose={onClose} />
      </LanguageProvider>,
    );
    expect(container.querySelector('.bg-black\\/40')).toBeNull();
  });

  it('slides off-canvas when closed and on-canvas when open', () => {
    const { container, rerender } = render(
      <LanguageProvider>
        <Sidebar open={false} onClose={vi.fn()} />
      </LanguageProvider>,
    );
    expect(container.querySelector('aside')?.className).toContain('-translate-x-full');

    rerender(
      <LanguageProvider>
        <Sidebar open onClose={vi.fn()} />
      </LanguageProvider>,
    );
    expect(container.querySelector('aside')?.className).toContain('translate-x-0');
  });

  it('translates labels through the language provider', () => {
    renderSidebar();
    // Rendered copy comes from t(labelKey), not the hardcoded `label`.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Leads')).toBeInTheDocument();
  });

  it('credits DoAide in the sidebar footer', () => {
    renderSidebar();
    const doaideLink = screen.getByRole('link', { name: 'DoAide' });
    expect(doaideLink).toHaveAttribute('href', 'https://doaide.com');
    expect(doaideLink).toHaveAttribute('target', '_blank');
  });
});
