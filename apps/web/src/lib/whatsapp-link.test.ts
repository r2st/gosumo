import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildWhatsAppLink, openWhatsApp } from './whatsapp-link';

describe('buildWhatsAppLink', () => {
  it('strips non-digit characters from the phone number', () => {
    expect(buildWhatsAppLink('+91 98765 43210')).toBe('https://wa.me/919876543210');
  });

  it('works with a plain digit string', () => {
    expect(buildWhatsAppLink('919876543210')).toBe('https://wa.me/919876543210');
  });

  it('returns empty string for an empty phone', () => {
    expect(buildWhatsAppLink('')).toBe('');
  });

  it('returns empty string for a phone with only non-digit chars', () => {
    expect(buildWhatsAppLink('++--')).toBe('');
  });

  it('appends an encoded message when provided', () => {
    const url = buildWhatsAppLink('+919876543210', 'Hello, I am your agent!');
    expect(url).toBe('https://wa.me/919876543210?text=Hello%2C%20I%20am%20your%20agent!');
  });

  it('omits the text param when message is undefined', () => {
    expect(buildWhatsAppLink('+919876543210')).toBe('https://wa.me/919876543210');
  });

  it('omits the text param when message is empty string', () => {
    expect(buildWhatsAppLink('+919876543210', '')).toBe('https://wa.me/919876543210');
  });

  it('encodes special characters in the message', () => {
    const url = buildWhatsAppLink('919876543210', 'Price: ₹50L & up');
    expect(url).toContain('text=');
    expect(url).toContain(encodeURIComponent('Price: ₹50L & up'));
  });
});

describe('openWhatsApp', () => {
  const originalOpen = window.open;

  beforeEach(() => {
    window.open = vi.fn();
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it('opens a new window with the wa.me link', () => {
    openWhatsApp('+919876543210', 'Hi');
    expect(window.open).toHaveBeenCalledWith(
      'https://wa.me/919876543210?text=Hi',
      '_blank',
      'noopener',
    );
  });

  it('does not open a window for an empty phone', () => {
    openWhatsApp('');
    expect(window.open).not.toHaveBeenCalled();
  });
});
