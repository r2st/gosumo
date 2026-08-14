/**
 * The dashboard route group's layout.
 *
 * One line, but a load-bearing one: it is what puts every authenticated route
 * behind `DashboardShell`, which is where the session guard and the nav live.
 * A page moved into this group and rendered without the shell would be
 * reachable without a session.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/dashboard-shell', () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{children}</div>
  ),
}));

import DashboardLayout from './layout';

describe('DashboardLayout', () => {
  it('wraps every route in the group with the guarded shell', () => {
    render(
      <DashboardLayout>
        <p>route content</p>
      </DashboardLayout>,
    );

    const shell = screen.getByTestId('dashboard-shell');
    expect(shell).toContainElement(screen.getByText('route content'));
  });
});
