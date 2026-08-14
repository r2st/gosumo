import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const logout = vi.fn();
let user: { name: string; email: string; role: string; avatarUrl?: string } | null = {
  name: 'Asha Rao',
  email: 'asha@brokerage.in',
  role: 'OWNER',
};
let business: { name: string; subscriptionPlan?: string; industry?: string } | null = {
  name: 'Rao Realty',
  subscriptionPlan: 'PRO',
  industry: 'Real Estate',
};

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user, business, logout }),
}));

// The notification centre owns its own queries; it is covered by its own test.
vi.mock('@/components/notifications/notification-center', () => ({
  NotificationCenter: () => <div data-testid="notifications" />,
}));

import { Topbar } from './topbar';
import { ThemeProvider } from '@/providers/theme-provider';
import { LanguageProvider } from '@/providers/language-provider';

// jsdom on an opaque origin exposes no localStorage; both providers persist there.
class LocalStorageMock {
  private store: Record<string, string> = {};
  clear() {
    this.store = {};
  }
  getItem(key: string) {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}
Object.defineProperty(globalThis, 'localStorage', {
  value: new LocalStorageMock(),
  configurable: true,
  writable: true,
});

function wrap(children: ReactNode) {
  return (
    <ThemeProvider>
      <LanguageProvider>{children}</LanguageProvider>
    </ThemeProvider>
  );
}

function renderTopbar(onMenuClick = vi.fn()) {
  const view = render(wrap(<Topbar onMenuClick={onMenuClick} />));
  return { ...view, onMenuClick };
}

describe('Topbar', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    logout.mockClear();
    user = { name: 'Asha Rao', email: 'asha@brokerage.in', role: 'OWNER' };
    business = { name: 'Rao Realty', subscriptionPlan: 'PRO', industry: 'Real Estate' };
  });

  describe('workspace identity', () => {
    it('shows the business name and plan', () => {
      renderTopbar();
      expect(screen.getByText('Rao Realty')).toBeInTheDocument();
      expect(screen.getByText('PRO plan · Real Estate')).toBeInTheDocument();
    });

    it('falls back to a generic workspace name before the business loads', () => {
      business = null;
      renderTopbar();
      expect(screen.getByText('GoSumo Workspace')).toBeInTheDocument();
    });

    it('says "Free plan" when the business carries neither plan nor industry', () => {
      business = { name: 'Rao Realty' };
      renderTopbar();
      expect(screen.getByText('Free plan')).toBeInTheDocument();
    });

    it('omits the empty half of the subtitle rather than leaving a dangling separator', () => {
      business = { name: 'Rao Realty', subscriptionPlan: 'PRO' };
      renderTopbar();
      expect(screen.getByText('PRO plan')).toBeInTheDocument();
    });

    it('treats an empty industry string as absent', () => {
      business = { name: 'Rao Realty', subscriptionPlan: 'PRO', industry: '' };
      renderTopbar();
      expect(screen.getByText('PRO plan')).toBeInTheDocument();
    });
  });

  describe('drawer trigger', () => {
    it('opens the sidebar', () => {
      const { onMenuClick } = renderTopbar();
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(onMenuClick).toHaveBeenCalledOnce();
    });

    it('is tablet-only — mobile uses the bottom nav, desktop has a fixed sidebar', () => {
      renderTopbar();
      expect(screen.getAllByRole('button')[0].className).toContain('md:inline-flex');
      expect(screen.getAllByRole('button')[0].className).toContain('lg:hidden');
    });
  });

  describe('language toggle', () => {
    it('shows the current language and offers the other one', () => {
      renderTopbar();
      expect(screen.getByLabelText('Switch to हिंदी')).toBeInTheDocument();
      expect(screen.getByText('English')).toBeInTheDocument();
    });

    it('switches language and then offers the way back', () => {
      renderTopbar();
      fireEvent.click(screen.getByLabelText('Switch to हिंदी'));
      expect(screen.getByLabelText('Switch to English')).toBeInTheDocument();
      expect(screen.getByText('हिंदी')).toBeInTheDocument();
    });
  });

  describe('theme toggle', () => {
    it('offers dark mode while light', () => {
      renderTopbar();
      expect(screen.getByLabelText('Switch to dark mode')).toBeInTheDocument();
    });

    it('flips the label after toggling', () => {
      renderTopbar();
      fireEvent.click(screen.getByLabelText('Switch to dark mode'));
      expect(screen.getByLabelText('Switch to light mode')).toBeInTheDocument();
    });
  });

  describe('user menu', () => {
    it('shows the signed-in name', () => {
      renderTopbar();
      expect(screen.getAllByText('Asha Rao').length).toBeGreaterThan(0);
    });

    it('falls back to "User" before the profile loads', () => {
      user = null;
      renderTopbar();
      expect(screen.getAllByText('User').length).toBeGreaterThan(0);
    });

    it('stays closed until the trigger is clicked', () => {
      renderTopbar();
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
    });

    it('reveals email and role when opened', () => {
      renderTopbar();
      fireEvent.click(screen.getByText('Asha Rao'));
      expect(screen.getByText('asha@brokerage.in')).toBeInTheDocument();
      expect(screen.getByText('OWNER')).toBeInTheDocument();
    });

    it('toggles shut on a second click', () => {
      renderTopbar();
      const trigger = screen.getByText('Asha Rao');
      fireEvent.click(trigger);
      expect(screen.getByText('Sign out')).toBeInTheDocument();
      fireEvent.click(trigger);
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
    });

    it('closes on an outside click', () => {
      // The invisible full-screen backdrop is the only dismiss affordance;
      // without it the menu stays pinned over the page.
      const { container } = renderTopbar();
      fireEvent.click(screen.getByText('Asha Rao'));
      const backdrop = container.querySelector('.fixed.inset-0');
      fireEvent.click(backdrop as Element);
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
    });

    it('signs out and closes the menu', () => {
      renderTopbar();
      fireEvent.click(screen.getByText('Asha Rao'));
      fireEvent.click(screen.getByText('Sign out'));
      expect(logout).toHaveBeenCalledOnce();
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
    });

    it('links to settings and closes on the way', () => {
      renderTopbar();
      fireEvent.click(screen.getByText('Asha Rao'));
      const profile = screen.getByText('Profile');
      expect(profile.closest('a')).toHaveAttribute('href', '/settings');
      fireEvent.click(profile);
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
    });
  });

  it('hosts the notification centre', () => {
    renderTopbar();
    expect(screen.getByTestId('notifications')).toBeInTheDocument();
  });
});
