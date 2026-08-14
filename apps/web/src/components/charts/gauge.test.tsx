import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Gauge } from './gauge';

/** The coloured value arc, i.e. the second path — the first is the grey track. */
function valueArc(container: HTMLElement) {
  return container.querySelectorAll('path')[1];
}

describe('Gauge', () => {
  it('renders the value as a whole percentage', () => {
    render(<Gauge value={42} />);
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('rounds a fractional value', () => {
    render(<Gauge value={42.6} />);
    expect(screen.getByText('43%')).toBeInTheDocument();
  });

  it('renders an optional label under the number', () => {
    render(<Gauge value={50} label="AI autonomy" />);
    expect(screen.getByText('AI autonomy')).toBeInTheDocument();
  });

  it('omits the label element entirely when none is given', () => {
    const { container } = render(<Gauge value={50} />);
    expect(container.querySelectorAll('text')).toHaveLength(1);
  });

  describe('clamping', () => {
    it('clamps above 100, so a bad metric cannot overdraw the arc', () => {
      render(<Gauge value={150} />);
      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('clamps below 0', () => {
      render(<Gauge value={-20} />);
      expect(screen.getByText('0%')).toBeInTheDocument();
    });
  });

  describe('value arc', () => {
    it('is omitted at zero rather than drawn as a stub', () => {
      // A zero-length arc with a round linecap still paints a visible dot,
      // which reads as a small non-zero value.
      const { container } = render(<Gauge value={0} />);
      expect(container.querySelectorAll('path')).toHaveLength(1);
    });

    it('is drawn for any positive value', () => {
      const { container } = render(<Gauge value={1} />);
      expect(container.querySelectorAll('path')).toHaveLength(2);
    });

    it('uses the short arc at or below the halfway mark', () => {
      const { container } = render(<Gauge value={50} />);
      expect(valueArc(container).getAttribute('d')).toMatch(/A [\d.]+ [\d.]+ 0 0 1/);
    });

    it('switches to the large arc past halfway', () => {
      // Getting the large-arc-flag wrong makes a 90% gauge render as 10%.
      const { container } = render(<Gauge value={51} />);
      expect(valueArc(container).getAttribute('d')).toMatch(/A [\d.]+ [\d.]+ 0 1 1/);
    });
  });

  describe('colour thresholds', () => {
    const cases: Array<[number, string]> = [
      [100, '--success'],
      [75, '--success'],
      [74, '--primary'],
      [50, '--primary'],
      [49, '--warning'],
      [25, '--warning'],
      [24, '--danger'],
      [1, '--danger'],
    ];

    it.each(cases)('paints %i% from %s', (value, token) => {
      const { container } = render(<Gauge value={value} />);
      expect(valueArc(container).getAttribute('stroke')).toBe(`hsl(var(${token}))`);
    });
  });

  describe('sizing', () => {
    it('defaults to 200px wide and half as tall plus the stroke', () => {
      const { container } = render(<Gauge value={50} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '200');
      expect(svg).toHaveAttribute('height', '118');
      expect(svg).toHaveAttribute('viewBox', '0 0 200 118');
    });

    it('honours a custom size and thickness', () => {
      const { container } = render(<Gauge value={50} size={100} thickness={10} />);
      const svg = container.querySelector('svg');
      expect(svg).toHaveAttribute('width', '100');
      expect(svg).toHaveAttribute('height', '60');
    });

    it('scales the label typography with the gauge', () => {
      const { container } = render(<Gauge value={50} size={100} />);
      expect(container.querySelector('text')).toHaveStyle({ fontSize: '17px' });
    });
  });

  it('starts the track at the left and sweeps to the right', () => {
    // The semicircle runs 180°→0°; flipping it would draw the gauge upside down.
    const { container } = render(<Gauge value={50} size={200} thickness={20} />);
    const track = container.querySelectorAll('path')[0];
    // sin(π) is not exactly 0 in floating point, so compare numerically.
    const [x1, y1, rx, , , largeArc, sweep, x2, y2] = (track.getAttribute('d') as string)
      .replace(/[MA]/g, ' ')
      .trim()
      .split(/\s+/)
      .map(Number);
    expect([x1, rx, largeArc, sweep, x2]).toEqual([10, 90, 1, 1, 190]);
    expect(y1).toBeCloseTo(100);
    expect(y2).toBeCloseTo(100);
  });
});
