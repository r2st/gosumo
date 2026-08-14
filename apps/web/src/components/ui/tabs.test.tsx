import { fireEvent, render, screen } from '@testing-library/react';
import { Building2, Target } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { LinkTabs, SegmentedTabs, type TabItem } from './tabs';

const ITEMS: TabItem[] = [
  { key: 'leads', label: 'Leads', href: '/leads', icon: Target },
  { key: 'inventory', label: 'Inventory', href: '/inventory', icon: Building2 },
  { key: 'exchange', label: 'Exchange', href: '/exchange' },
];

describe('LinkTabs', () => {
  it('renders one link per item, pointing at its href', () => {
    render(<LinkTabs items={ITEMS} activeKey="leads" />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/leads',
      '/inventory',
      '/exchange',
    ]);
  });

  it('underlines only the active tab', () => {
    render(<LinkTabs items={ITEMS} activeKey="inventory" />);
    const active = screen.getAllByRole('link').filter((l) => l.className.includes('border-primary'));
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute('href', '/inventory');
  });

  it('underlines nothing when the active key matches no tab', () => {
    render(<LinkTabs items={ITEMS} activeKey="nope" />);
    expect(
      screen.getAllByRole('link').filter((l) => l.className.includes('border-primary')),
    ).toHaveLength(0);
  });

  it('falls back to "#" for an item with no href, rather than rendering an invalid link', () => {
    render(<LinkTabs items={[{ key: 'a', label: 'A' }]} activeKey="a" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '#');
  });

  it('renders an icon only for items that supply one', () => {
    const { container } = render(<LinkTabs items={ITEMS} activeKey="leads" />);
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('keeps labels on one line and scrolls instead, so tabs never wrap on mobile', () => {
    render(<LinkTabs items={ITEMS} activeKey="leads" />);
    expect(screen.getAllByRole('link')[0].className).toContain('whitespace-nowrap');
    expect(screen.getByRole('navigation').className).toContain('overflow-x-auto');
  });

  it('renders nothing but the nav for an empty item list', () => {
    render(<LinkTabs items={[]} activeKey="" />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('SegmentedTabs', () => {
  it('renders one button per item', () => {
    render(<SegmentedTabs items={ITEMS} activeKey="leads" onChange={vi.fn()} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Leads',
      'Inventory',
      'Exchange',
    ]);
  });

  it('highlights only the active segment', () => {
    render(<SegmentedTabs items={ITEMS} activeKey="exchange" onChange={vi.fn()} />);
    const active = screen.getAllByRole('button').filter((b) => b.className.includes('bg-primary'));
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveTextContent('Exchange');
  });

  it('reports the chosen key', () => {
    const onChange = vi.fn();
    render(<SegmentedTabs items={ITEMS} activeKey="leads" onChange={onChange} />);
    fireEvent.click(screen.getByText('Inventory'));
    expect(onChange).toHaveBeenCalledWith('inventory');
  });

  it('still fires when the active segment is re-clicked', () => {
    // Callers use this to re-run a filter; swallowing the click would make the
    // control feel dead.
    const onChange = vi.fn();
    render(<SegmentedTabs items={ITEMS} activeKey="leads" onChange={onChange} />);
    fireEvent.click(screen.getByText('Leads'));
    expect(onChange).toHaveBeenCalledWith('leads');
  });

  it('does not navigate — these switch in-page state', () => {
    render(<SegmentedTabs items={ITEMS} activeKey="leads" onChange={vi.fn()} />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('wraps rather than overflowing when there are many segments', () => {
    const { container } = render(
      <SegmentedTabs items={ITEMS} activeKey="leads" onChange={vi.fn()} />,
    );
    expect(container.firstElementChild?.className).toContain('flex-wrap');
  });

  it('renders an empty shell for an empty item list', () => {
    render(<SegmentedTabs items={[]} activeKey="" onChange={vi.fn()} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
