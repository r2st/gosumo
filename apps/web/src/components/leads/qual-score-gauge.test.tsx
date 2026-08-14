import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QualScoreGauge } from './qual-score-gauge';

/** The value ring is the second circle; the first is the muted track. */
function valueRing(container: HTMLElement) {
  return container.querySelectorAll('circle')[1];
}

describe('QualScoreGauge', () => {
  it('renders the score', () => {
    render(<QualScoreGauge score={72} />);
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('Score')).toBeInTheDocument();
  });

  it('announces the score to assistive tech', () => {
    // The number alone is meaningless out of context to a screen reader.
    render(<QualScoreGauge score={72} />);
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      'Qualification score 72 out of 100',
    );
  });

  describe('clamping', () => {
    it('clamps above 100', () => {
      render(<QualScoreGauge score={140} />);
      expect(screen.getByText('100')).toBeInTheDocument();
    });

    it('clamps below zero', () => {
      render(<QualScoreGauge score={-5} />);
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('announces the clamped value, not the raw one', () => {
      render(<QualScoreGauge score={140} />);
      expect(screen.getByRole('img')).toHaveAttribute(
        'aria-label',
        'Qualification score 100 out of 100',
      );
    });
  });

  describe('colour bands', () => {
    it('greens a qualified score at 70 and above', () => {
      const { container } = render(<QualScoreGauge score={70} />);
      expect(valueRing(container).getAttribute('class')).toContain('text-emerald-500');
    });

    it('ambers a middling score from 40', () => {
      const { container } = render(<QualScoreGauge score={40} />);
      expect(valueRing(container).getAttribute('class')).toContain('text-amber-500');
    });

    it('greys a cold score below 40', () => {
      const { container } = render(<QualScoreGauge score={39} />);
      expect(valueRing(container).getAttribute('class')).toContain('text-slate-400');
    });

    it('holds the 70 boundary exactly', () => {
      // 69 vs 70 is the difference between "chase this lead" and "park it".
      const { container } = render(<QualScoreGauge score={69} />);
      expect(valueRing(container).getAttribute('class')).toContain('text-amber-500');
    });

    it('colours the number to match the ring', () => {
      render(<QualScoreGauge score={80} />);
      expect(screen.getByText('80').className).toContain('text-emerald-500');
    });
  });

  describe('the arc', () => {
    it('draws nothing at zero', () => {
      const { container } = render(<QualScoreGauge score={0} />);
      expect(valueRing(container).getAttribute('stroke-dasharray')?.startsWith('0 ')).toBe(true);
    });

    it('closes the ring at 100', () => {
      const { container } = render(<QualScoreGauge score={100} size={96} />);
      const [dash, gap] = (valueRing(container).getAttribute('stroke-dasharray') as string)
        .split(' ')
        .map(Number);
      expect(gap).toBeCloseTo(0);
      expect(dash).toBeCloseTo(2 * Math.PI * ((96 - 8) / 2));
    });

    it('fills half the ring at 50', () => {
      const { container } = render(<QualScoreGauge score={50} size={96} />);
      const [dash, gap] = (valueRing(container).getAttribute('stroke-dasharray') as string)
        .split(' ')
        .map(Number);
      expect(dash).toBeCloseTo(gap);
    });

    it('starts the arc at twelve o’clock', () => {
      // Without the -90° rotation the score sweeps from the right edge, which
      // reads as a different value at a glance.
      const { container } = render(<QualScoreGauge score={50} />);
      expect(container.querySelector('svg')?.getAttribute('class')).toContain('-rotate-90');
    });
  });

  describe('sizing', () => {
    it('defaults to 96px square', () => {
      const { container } = render(<QualScoreGauge score={50} />);
      expect(container.firstElementChild).toHaveStyle({ width: '96px', height: '96px' });
    });

    it('honours a custom size', () => {
      const { container } = render(<QualScoreGauge score={50} size={48} />);
      expect(container.querySelector('svg')).toHaveAttribute('width', '48');
      expect(container.firstElementChild).toHaveStyle({ width: '48px' });
    });

    it('keeps the stroke inside the box', () => {
      // radius = (size - stroke) / 2, so the ring never clips at the edge.
      const { container } = render(<QualScoreGauge score={50} size={48} />);
      expect(valueRing(container).getAttribute('r')).toBe('20');
    });
  });

  it('merges a caller className', () => {
    const { container } = render(<QualScoreGauge score={50} className="shrink-0" />);
    expect(container.firstElementChild?.className).toContain('shrink-0');
  });
});
