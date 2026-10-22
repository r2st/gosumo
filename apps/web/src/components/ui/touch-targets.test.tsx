/**
 * Mobile touch targets: below the `sm` breakpoint every interactive primitive
 * must be at least 48px (Tailwind `12`) in its tappable dimension.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { Input } from './input';
import { Select } from './select';
import { PublicNav } from '@/components/public-layout';

describe('48px touch targets on phones', () => {
  it.each(['sm', 'md', 'lg'] as const)('Button size=%s grows to h-12', (size) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('max-sm:h-12');
  });

  it('icon buttons are 48px square', () => {
    render(<Button size="icon" aria-label="Close">x</Button>);
    const cls = screen.getByRole('button', { name: 'Close' }).className;
    expect(cls).toContain('max-sm:h-12');
    expect(cls).toContain('max-sm:w-12');
  });

  it('inputs and selects are 48px with 16px text', () => {
    render(
      <>
        <Input aria-label="Name" />
        <Select aria-label="Pick" options={[{ label: 'A', value: 'a' }]} />
      </>,
    );
    for (const el of [screen.getByLabelText('Name'), screen.getByLabelText('Pick')]) {
      expect(el.className).toContain('max-sm:h-12');
      expect(el.className).toContain('max-sm:text-base');
    }
  });

  it('public nav keeps its phone-visible links at 48px', () => {
    render(<PublicNav />);
    for (const name of ['Free Tools', 'Support', 'Get Started']) {
      expect(screen.getByRole('link', { name }).className).toContain('min-h-12');
    }
  });
});
