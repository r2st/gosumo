/**
 * The non-text half of the message bubble: the media content types, the
 * delivery ticks, the day divider, and internal notes.
 *
 * `message-bubble.test.tsx` covers text and AI-confidence routing. The stored
 * `content` payload is polymorphic JSONB rather than the union the type
 * claims, so most cases here are about degrading gracefully — a media message
 * missing its URL must not render an empty <img>, and an unknown type that
 * carries text should still show the text.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DayDivider, MessageBody, MessageBubble } from './message-bubble';
import type { Message } from '@/lib/types';

// Loosely typed on purpose: several cases feed content shapes that do not
// satisfy the strict Message['content'] union, which is the point.
function makeMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'c1',
    businessId: 'b1',
    direction: 'INBOUND',
    contentType: 'TEXT',
    content: { type: 'TEXT', text: 'Hello world' },
    status: 'DELIVERED',
    sentByAi: false,
    timestamp: '2026-06-27T10:00:00.000Z',
    metadata: {},
    ...overrides,
  } as unknown as Message;
}

const body = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  render(<MessageBody message={makeMessage({ content, ...extra })} />);

describe('DOCUMENT', () => {
  it('links to the document by filename', () => {
    body({ type: 'DOCUMENT', url: 'https://cdn.test/quote.pdf', filename: 'Quote.pdf' });
    const link = screen.getByRole('link', { name: /quote\.pdf/i }) as HTMLAnchorElement;
    expect(link.href).toBe('https://cdn.test/quote.pdf');
  });

  it('opens in a new tab without leaking the referrer', () => {
    body({ type: 'DOCUMENT', url: 'https://cdn.test/quote.pdf', filename: 'Quote.pdf' });
    const link = screen.getByRole('link') as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noreferrer');
  });

  it('falls back to a generic name when the filename is missing', () => {
    body({ type: 'DOCUMENT', url: 'https://cdn.test/x.pdf' });
    expect(screen.getByRole('link', { name: /document/i })).toBeTruthy();
  });

  it('degrades to a placeholder rather than a dead link when the URL is missing', () => {
    body({ type: 'DOCUMENT', filename: 'Quote.pdf' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('DOCUMENT')).toBeTruthy();
  });

  it('shows the caption text instead when the payload also carries text', () => {
    body({ type: 'DOCUMENT', text: 'see attached' });
    expect(screen.getByText('see attached')).toBeTruthy();
  });
});

describe('LOCATION', () => {
  it('shows the place name when one is given', () => {
    body({ type: 'LOCATION', name: 'Prestige Lakeside', latitude: 12.9, longitude: 77.6 });
    expect(screen.getByText('Prestige Lakeside')).toBeTruthy();
  });

  it('falls back to the coordinates when unnamed', () => {
    body({ type: 'LOCATION', latitude: 12.9, longitude: 77.6 });
    expect(screen.getByText('12.9, 77.6')).toBeTruthy();
  });

  it('marks missing coordinates rather than rendering "undefined"', () => {
    body({ type: 'LOCATION' });
    expect(screen.getByText('?, ?')).toBeTruthy();
  });

  it('marks only the coordinate that is actually missing', () => {
    body({ type: 'LOCATION', latitude: 12.9 });
    expect(screen.getByText('12.9, ?')).toBeTruthy();
  });
});

describe('PAYMENT_LINK', () => {
  it('renders the amount converted from paise to rupees', () => {
    body({ type: 'PAYMENT_LINK', url: 'https://pay.test/x', amount: 1_050_000 });
    expect(screen.getByRole('link').textContent).toContain('₹10,500.00');
  });

  it('renders ₹0.00 rather than NaN when the amount is missing', () => {
    body({ type: 'PAYMENT_LINK', url: 'https://pay.test/x' });
    expect(screen.getByRole('link').textContent).toContain('₹0.00');
  });

  it('opens in a new tab without leaking the referrer', () => {
    body({ type: 'PAYMENT_LINK', url: 'https://pay.test/x', amount: 100 });
    const link = screen.getByRole('link') as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noreferrer');
  });
});

describe('TEMPLATE', () => {
  it('names the template that was sent', () => {
    body({ type: 'TEMPLATE', templateName: 'order_confirmed_v2' });
    expect(screen.getByText(/order_confirmed_v2/)).toBeTruthy();
  });

  it('renders the label alone when the template name is missing', () => {
    const { container } = body({ type: 'TEMPLATE' });
    expect(container.textContent).toContain('Template:');
  });
});

describe('VIDEO', () => {
  it('renders a player for a video with a URL', () => {
    const { container } = body({ type: 'VIDEO', url: 'https://cdn.test/clip.mp4' });
    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toBe('https://cdn.test/clip.mp4');
    expect(video?.hasAttribute('controls')).toBe(true);
  });

  it('degrades to a placeholder when the video URL is missing', () => {
    const { container } = body({ type: 'VIDEO' });
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('VIDEO')).toBeTruthy();
  });

  it('prefers the text when a URL-less video still carries text', () => {
    body({ type: 'VIDEO', text: 'video failed to upload' });
    expect(screen.getByText('video failed to upload')).toBeTruthy();
  });
});

describe('IMAGE', () => {
  it('uses the caption as the alt text', () => {
    body({ type: 'IMAGE', url: 'https://cdn.test/a.jpg', caption: 'Living room' });
    expect(screen.getByRole('img', { name: 'Living room' })).toBeTruthy();
    expect(screen.getByText('Living room')).toBeTruthy();
  });

  it('falls back to a generic alt when there is no caption', () => {
    body({ type: 'IMAGE', url: 'https://cdn.test/a.jpg' });
    expect(screen.getByRole('img', { name: 'image' })).toBeTruthy();
  });

  it('degrades to a placeholder when the image URL is missing', () => {
    body({ type: 'IMAGE', caption: 'Living room' });
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('unknown and empty payloads', () => {
  it('shows the text of an unrecognised type', () => {
    body({ type: 'STICKER', text: 'a sticker caption' });
    expect(screen.getByText('a sticker caption')).toBeTruthy();
  });

  it('names an unrecognised type when there is nothing to show', () => {
    body({ type: 'STICKER' });
    expect(screen.getByText('STICKER')).toBeTruthy();
  });

  it('reports an entirely empty payload as unsupported', () => {
    body({});
    expect(screen.getByText('Unsupported message')).toBeTruthy();
  });

  it('survives a null content column', () => {
    render(<MessageBody message={makeMessage({ content: null })} />);
    expect(screen.getByText('Unsupported message')).toBeTruthy();
  });
});

describe('delivery ticks', () => {
  const ticks = (overrides: Record<string, unknown>): SVGElement[] => {
    const { container } = render(<MessageBubble message={makeMessage(overrides)} />);
    return Array.from(container.querySelectorAll('svg'));
  };

  const tickClasses = (overrides: Record<string, unknown>): string =>
    ticks(overrides)
      .map((s) => s.getAttribute('class') ?? '')
      .join(' ');

  it('shows no tick on an inbound message', () => {
    // Inbound has no delivery state of ours to report.
    expect(tickClasses({ direction: 'INBOUND', status: 'READ' })).not.toContain('text-sky-500');
  });

  it('shows a blue double-check once read', () => {
    expect(tickClasses({ direction: 'OUTBOUND', status: 'READ' })).toContain('text-sky-500');
  });

  it('shows a grey tick once delivered', () => {
    expect(tickClasses({ direction: 'OUTBOUND', status: 'DELIVERED' })).toContain(
      'text-slate-500',
    );
  });

  it('shows a grey tick once sent', () => {
    expect(tickClasses({ direction: 'OUTBOUND', status: 'SENT' })).toContain(
      'text-slate-500',
    );
  });

  it('shows an alert when delivery failed', () => {
    expect(tickClasses({ direction: 'OUTBOUND', status: 'FAILED' })).toContain(
      'text-rose-500',
    );
  });

  it('shows a clock for a status that is none of those (still queued)', () => {
    expect(tickClasses({ direction: 'OUTBOUND', status: 'QUEUED' })).toContain(
      'text-slate-400',
    );
  });
});

describe('MessageBubble layout', () => {
  it('renders an internal note centred and labelled, not as a customer message', () => {
    render(
      <MessageBubble
        message={makeMessage({
          direction: 'INTERNAL',
          content: { type: 'TEXT', text: 'chase the builder' },
        })}
      />,
    );
    expect(screen.getByText(/internal note/i)).toBeTruthy();
    expect(screen.getByText('chase the builder')).toBeTruthy();
  });

  it('right-aligns an outbound bubble and left-aligns an inbound one', () => {
    const { container: out } = render(
      <MessageBubble message={makeMessage({ direction: 'OUTBOUND' })} />,
    );
    expect(out.firstElementChild?.className).toContain('justify-end');

    const { container: inb } = render(
      <MessageBubble message={makeMessage({ direction: 'INBOUND' })} />,
    );
    expect(inb.firstElementChild?.className).toContain('justify-start');
  });

  it('renders the send time in IST', () => {
    render(
      <MessageBubble
        message={makeMessage({ timestamp: '2026-06-27T10:00:00.000Z' })}
      />,
    );
    // 10:00 UTC is 3:30 PM IST.
    expect(screen.getByText('3:30 PM')).toBeTruthy();
  });

  it('marks an AI-sent message with the bot indicator', () => {
    const { container } = render(
      <MessageBubble message={makeMessage({ sentByAi: true, aiConfidence: 95 })} />,
    );
    expect(screen.getByText('Auto')).toBeTruthy();
    expect(container.querySelector('.lucide-bot')).toBeTruthy();
  });
});

describe('DayDivider', () => {
  it('renders the label it is given', () => {
    render(<DayDivider label="Yesterday" />);
    expect(screen.getByText('Yesterday')).toBeTruthy();
  });

  it('renders nothing for an empty label rather than an empty pill', () => {
    const { container } = render(<DayDivider label="" />);
    expect(container.firstChild).toBeNull();
  });
});
