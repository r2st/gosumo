/**
 * The content-shaped loading placeholders.
 *
 * Two properties matter and neither is visual. First, each placeholder must
 * announce itself once as a single "Loading…" status — a screen reader hitting
 * forty empty divs instead is worse than the spinner these replaced. Second,
 * the placeholder must reserve the *real* layout (a table keeps its headers, a
 * grid keeps its columns), because reserving the wrong shape reintroduces
 * exactly the layout jump it is meant to prevent.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CardsSkeleton,
  GridSkeleton,
  ListRowsSkeleton,
  TableSkeleton,
  ThreadSkeleton,
} from './skeletons';

describe('accessibility contract', () => {
  it.each([
    ['list', <ListRowsSkeleton key="l" />],
    ['table', <TableSkeleton key="t" headers={['A', 'B']} />],
    ['cards', <CardsSkeleton key="c" />],
    ['grid', <GridSkeleton key="g" />],
    ['thread', <ThreadSkeleton key="th" />],
  ])('exposes the %s placeholder as a single status region', (_name, element) => {
    render(element);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('announces a caller-supplied label', () => {
    render(<ListRowsSkeleton label="Loading conversations…" />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading conversations…');
  });

  it('hides the decorative boxes from assistive tech', () => {
    const { container } = render(<ListRowsSkeleton rows={3} />);
    const hidden = container.querySelector('[aria-hidden="true"]');

    expect(hidden).toBeInTheDocument();
    // Every pulsing box lives inside the hidden subtree, not beside it.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(within(hidden as HTMLElement).getAllByText('', { selector: '.animate-pulse' }).length)
      .toBe(container.querySelectorAll('.animate-pulse').length);
  });
});

describe('ListRowsSkeleton', () => {
  // Queried through the DOM rather than by role: the rows sit inside the
  // aria-hidden subtree by design, so they are deliberately absent from the
  // accessibility tree.
  it('renders the requested number of rows', () => {
    const { container } = render(<ListRowsSkeleton rows={4} />);
    expect(container.querySelectorAll('li')).toHaveLength(4);
  });

  it('defaults to a full-looking list rather than a single row', () => {
    const { container } = render(<ListRowsSkeleton />);
    expect(container.querySelectorAll('li')).toHaveLength(6);
  });

  it('is not announced as a list to assistive tech', () => {
    render(<ListRowsSkeleton rows={4} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('TableSkeleton', () => {
  it('keeps the real headers visible so columns do not resize on load', () => {
    render(<TableSkeleton headers={['Client', 'Orders', 'Total spent', 'Last active']} rows={2} />);

    expect(screen.getByText('Client')).toBeInTheDocument();
    expect(screen.getByText('Total spent')).toBeInTheDocument();
  });

  it('renders one placeholder cell per header, per row', () => {
    const { container } = render(<TableSkeleton headers={['A', 'B', 'C']} rows={4} />);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
    expect(container.querySelectorAll('tbody td')).toHaveLength(12);
  });

  it('handles a single-column table', () => {
    const { container } = render(<TableSkeleton headers={['Only']} rows={2} />);
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
  });
});

describe('CardsSkeleton', () => {
  it('renders the requested number of cards', () => {
    const { container } = render(<CardsSkeleton cards={5} />);
    expect(container.querySelectorAll('.rounded-lg.border')).toHaveLength(5);
  });
});

describe('GridSkeleton', () => {
  it('reserves the aspect-video media block each catalog card has', () => {
    const { container } = render(<GridSkeleton cards={3} />);
    expect(container.querySelectorAll('.aspect-video')).toHaveLength(3);
  });

  it('keeps the responsive column classes the real grid uses', () => {
    const { container } = render(<GridSkeleton />);
    const grid = container.querySelector('.grid');
    expect(grid?.className).toContain('sm:grid-cols-2');
    expect(grid?.className).toContain('xl:grid-cols-4');
  });
});

describe('ThreadSkeleton', () => {
  it('alternates sides, because the left/right rhythm is the thread layout', () => {
    const { container } = render(<ThreadSkeleton messages={4} />);
    const rows = Array.from(container.querySelectorAll('.flex.justify-start, .flex.justify-end'));

    expect(rows).toHaveLength(4);
    expect(rows[0].className).toContain('justify-start');
    expect(rows[1].className).toContain('justify-end');
    expect(rows[2].className).toContain('justify-start');
    expect(rows[3].className).toContain('justify-end');
  });

  it('renders the requested number of bubbles', () => {
    const { container } = render(<ThreadSkeleton messages={7} />);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(7);
  });
});
