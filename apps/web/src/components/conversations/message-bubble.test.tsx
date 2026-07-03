import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from './message-bubble';
import type { Message } from '@/lib/types';

// Overrides are intentionally loosely typed: several tests feed malformed
// `content` shapes that don't satisfy the strict Message['content'] union.
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

describe('MessageBubble', () => {
  it('renders text from a well-formed TEXT content payload', () => {
    render(<MessageBubble message={makeMessage()} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders text when content is a plain {text} object with no type', () => {
    const message = makeMessage({ content: { text: 'Plain text message' } });
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Plain text message')).toBeInTheDocument();
  });

  it('falls back to text_content when content carries no text field', () => {
    const message = makeMessage({ content: {}, text_content: 'From column' });
    render(<MessageBubble message={message} />);
    expect(screen.getByText('From column')).toBeInTheDocument();
  });

  it('handles a lower-cased content type', () => {
    const message = makeMessage({ content: { type: 'text', text: 'lowercase type' } });
    render(<MessageBubble message={message} />);
    expect(screen.getByText('lowercase type')).toBeInTheDocument();
  });

  it('does not render a broken image placeholder for a text message', () => {
    const message = makeMessage({ content: { text: 'just text' } });
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('just text')).toBeInTheDocument();
  });

  it('renders an image when an IMAGE payload has a url', () => {
    const message = makeMessage({
      contentType: 'IMAGE',
      content: { type: 'IMAGE', url: 'https://cdn/x.jpg', caption: 'a cat' },
    });
    const { container } = render(<MessageBubble message={message} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://cdn/x.jpg');
  });
});
