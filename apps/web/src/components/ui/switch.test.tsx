/**
 * Switch — naming, and the two ways to do it.
 *
 * The toggle is a `<button role="switch">` with no text content, so it has no
 * accessible name of its own. Neither does a `<label>` wrapped around it —
 * a button takes its name from its contents, and there are none. Every screen
 * reader therefore announces a bare Switch as an unnamed on/off control.
 *
 * There are two ways to name it, and picking the wrong one is a visible bug
 * rather than an invisible one:
 *
 *  - `label` when this component owns the visible text — it renders a `<span>`
 *    beside the toggle *and* names it.
 *  - `ariaLabel` when the visible text already exists outside: a sibling span,
 *    a table row, a card title. Passing `label` there would render a second
 *    copy of the text next to the first.
 *
 * The layout rule is the load-bearing part: a Switch given only `ariaLabel`
 * must render exactly as a bare one, or every call site that adopts it shifts.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './switch';

describe('Switch — accessible name', () => {
  it('has no name at all when given neither prop', () => {
    // Documenting the failure mode this component's props exist to prevent.
    render(<Switch checked={false} onChange={vi.fn()} />);

    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-label');
  });

  it('names itself from `label`, and shows that text', () => {
    render(<Switch checked={false} onChange={vi.fn()} label="Enable AI auto-reply" />);

    expect(screen.getByRole('switch', { name: 'Enable AI auto-reply' })).toBeInTheDocument();
    expect(screen.getByText('Enable AI auto-reply')).toBeInTheDocument();
  });

  it('names itself from `ariaLabel` without rendering any text', () => {
    render(<Switch checked={false} onChange={vi.fn()} ariaLabel="Open on Monday" />);

    expect(screen.getByRole('switch', { name: 'Open on Monday' })).toBeInTheDocument();
    // The call site already shows "Monday" beside it; a second copy would be
    // a visual regression on every page that adopts this prop.
    expect(screen.queryByText('Open on Monday')).not.toBeInTheDocument();
  });

  it('renders `ariaLabel`-only exactly as a bare switch does', () => {
    const { container: bare } = render(<Switch checked={false} onChange={vi.fn()} />);
    const { container: named } = render(
      <Switch checked={false} onChange={vi.fn()} ariaLabel="Low stock only" />,
    );

    // Same element, no wrapper — the button is the root in both cases.
    expect(named.firstElementChild?.tagName).toBe(bare.firstElementChild?.tagName);
    expect(named.querySelectorAll('span')).toHaveLength(bare.querySelectorAll('span').length);
  });

  it('lets `ariaLabel` win when both are given', () => {
    // The visible text and the spoken name can legitimately differ — "On the
    // exchange" reads fine on screen but needs more context out loud.
    render(
      <Switch
        checked
        onChange={vi.fn()}
        label="On the exchange"
        ariaLabel="List this project on the co-broking exchange"
      />,
    );

    expect(
      screen.getByRole('switch', { name: 'List this project on the co-broking exchange' }),
    ).toBeInTheDocument();
    expect(screen.getByText('On the exchange')).toBeInTheDocument();
  });

  it('renders the description beside the label', () => {
    render(
      <Switch
        checked
        onChange={vi.fn()}
        label="Enable AI auto-reply"
        description="When confident, the AI answers customers automatically."
      />,
    );

    expect(
      screen.getByText('When confident, the AI answers customers automatically.'),
    ).toBeInTheDocument();
  });
});

describe('Switch — state and interaction', () => {
  it('reports its state to assistive tech, not only through colour', () => {
    const { rerender } = render(<Switch checked={false} onChange={vi.fn()} ariaLabel="Toggle" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    rerender(<Switch checked onChange={vi.fn()} ariaLabel="Toggle" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('reports the value it is being flipped to', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} ariaLabel="Toggle" />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('flips back off from on', () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} ariaLabel="Toggle" />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('sends nothing while disabled', () => {
    // A pending mutation disables the switch; a second click must not queue a
    // conflicting write behind the first.
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} disabled ariaLabel="Toggle" />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('never submits the form it sits in', () => {
    // Without type="button" this would submit any enclosing <form> on click.
    render(<Switch checked={false} onChange={vi.fn()} ariaLabel="Toggle" />);

    expect(screen.getByRole('switch')).toHaveAttribute('type', 'button');
  });

  it('takes an id so an external <label htmlFor> can point at it', () => {
    render(<Switch checked={false} onChange={vi.fn()} id="office-hours" ariaLabel="Toggle" />);

    expect(screen.getByRole('switch')).toHaveAttribute('id', 'office-hours');
  });
});
