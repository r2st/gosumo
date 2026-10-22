import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationQuality } from '@/lib/feature-types';

const useConversationQuality = vi.fn();
vi.mock('@/hooks/use-analytics', () => ({
  useConversationQuality: () => useConversationQuality(),
}));

import { SupportMetrics, describeCsat } from './support-metrics';

const quality: ConversationQuality = {
  volume: { created: 40, resolved: 30, open: 12, pendingHuman: 3, escalated: 1 },
  resolutionRate: 75,
  responseTime: {
    avgFirstResponseSeconds: 150,
    p50FirstResponseSeconds: 60,
    p90FirstResponseSeconds: 600,
    sampleSize: 30,
  },
  csat: {
    explicitResponses: 4,
    explicitAverage: 4.5,
    proxySampled: 26,
    proxyAverage: 4.1,
    combinedAverage: 4.16,
    combinedSampled: 30,
  },
};

beforeEach(() => useConversationQuality.mockReset());

describe('describeCsat', () => {
  it('shows a dash before anything is resolved', () => {
    expect(describeCsat(undefined)).toEqual({ value: '—', hint: 'No resolved tickets yet' });
  });

  it('says how much of the score is real ratings versus estimate', () => {
    expect(describeCsat(quality.csat)).toEqual({ value: '4.2 / 5', hint: '4 rated · 26 estimated' });
    expect(describeCsat({ ...quality.csat, explicitResponses: 0 }).hint).toBe('Estimated from 26 resolved tickets');
    expect(describeCsat({ ...quality.csat, proxySampled: 0 }).hint).toBe('4 customer ratings');
  });
});

describe('SupportMetrics', () => {
  it('renders open tickets, first response time and satisfaction', () => {
    useConversationQuality.mockReturnValue({ data: quality, isLoading: false, isError: false });
    render(<SupportMetrics />);

    expect(screen.getByText('Open tickets')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('4 waiting on a person')).toBeInTheDocument();
    expect(screen.getByText('2m 30s')).toBeInTheDocument();
    expect(screen.getByText('90% within 10m')).toBeInTheDocument();
    expect(screen.getByText('4.2 / 5')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('handles a fresh tenant with no data', () => {
    useConversationQuality.mockReturnValue({
      data: {
        ...quality,
        volume: { created: 0, resolved: 0, open: 0, pendingHuman: 0, escalated: 0 },
        resolutionRate: 0,
        responseTime: { avgFirstResponseSeconds: 0, p50FirstResponseSeconds: 0, p90FirstResponseSeconds: 0, sampleSize: 0 },
        csat: { ...quality.csat, combinedAverage: null, combinedSampled: 0 },
      },
      isLoading: false,
      isError: false,
    });
    render(<SupportMetrics />);
    expect(screen.getByText('No replies yet')).toBeInTheDocument();
    expect(screen.getByText('No resolved tickets yet')).toBeInTheDocument();
  });
});
