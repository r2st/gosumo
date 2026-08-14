import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let status: 'loading' | 'authenticated' | 'unauthenticated' = 'authenticated';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ status }),
}));

// The shell's job is composition and gating; each child has its own test.
vi.mock('./sidebar', () => ({
  Sidebar: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid="sidebar" data-open={open}>
      <button onClick={onClose}>close-sidebar</button>
    </div>
  ),
}));
vi.mock('./topbar', () => ({
  Topbar: ({ onMenuClick }: { onMenuClick: () => void }) => (
    <button onClick={onMenuClick}>open-from-topbar</button>
  ),
}));
vi.mock('./bottom-nav', () => ({
  BottomNav: ({ onMore }: { onMore: () => void }) => <button onClick={onMore}>open-from-more</button>,
}));
vi.mock('@/components/onboarding/onboarding-gate', () => ({
  OnboardingGate: () => <div data-testid="onboarding-gate" />,
}));

import { DashboardShell } from './dashboard-shell';

function renderShell() {
  return render(
    <DashboardShell>
      <p>workspace content</p>
    </DashboardShell>,
  );
}

describe('DashboardShell', () => {
  beforeEach(() => {
    replace.mockClear();
    status = 'authenticated';
  });

  describe('auth gating', () => {
    it('renders the workspace once authenticated', () => {
      renderShell();
      expect(screen.getByText('workspace content')).toBeInTheDocument();
    });

    it('shows a loading state while the session is still resolving', () => {
      // Rendering children during `loading` would flash the dashboard to a
      // signed-out visitor before the redirect lands.
      status = 'loading';
      renderShell();
      expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
      expect(screen.getByText('Loading your workspace…')).toBeInTheDocument();
    });

    it('does not redirect while still loading', () => {
      status = 'loading';
      renderShell();
      expect(replace).not.toHaveBeenCalled();
    });

    it('redirects to login once known unauthenticated', () => {
      status = 'unauthenticated';
      renderShell();
      expect(replace).toHaveBeenCalledWith('/login');
    });

    it('withholds the workspace from an unauthenticated visitor', () => {
      status = 'unauthenticated';
      renderShell();
      expect(screen.queryByText('workspace content')).not.toBeInTheDocument();
    });

    it('does not redirect an authenticated user', () => {
      renderShell();
      expect(replace).not.toHaveBeenCalled();
    });

    it('redirects when the session drops mid-session', () => {
      const { rerender } = renderShell();
      expect(replace).not.toHaveBeenCalled();
      status = 'unauthenticated';
      rerender(
        <DashboardShell>
          <p>workspace content</p>
        </DashboardShell>,
      );
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });

  describe('sidebar coordination', () => {
    it('starts closed', () => {
      renderShell();
      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');
    });

    it('opens from the topbar hamburger', () => {
      renderShell();
      fireEvent.click(screen.getByText('open-from-topbar'));
      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');
    });

    it('opens from the bottom nav "More" tab', () => {
      renderShell();
      fireEvent.click(screen.getByText('open-from-more'));
      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');
    });

    it('closes again from the sidebar', () => {
      renderShell();
      fireEvent.click(screen.getByText('open-from-topbar'));
      fireEvent.click(screen.getByText('close-sidebar'));
      expect(screen.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');
    });
  });

  it('mounts the onboarding gate alongside the workspace', () => {
    renderShell();
    expect(screen.getByTestId('onboarding-gate')).toBeInTheDocument();
  });

  it('keeps content clear of the fixed mobile bottom nav', () => {
    // Without pb-14 the last row of any list sits under the tab bar and cannot
    // be tapped on a phone.
    const { container } = renderShell();
    const main = container.querySelector('main');
    expect(main?.className).toContain('pb-14');
    expect(main?.className).toContain('md:pb-0');
  });
});
