/**
 * ChannelIcon / channelLabel.
 *
 * Both are lookups into a `Record<ChannelType, …>` with a `??` fallback. The
 * fallback is the part worth testing: `ChannelType` is a local mirror of the
 * API's enum (see the app's CLAUDE.md — types are kept local so the frontend
 * builds independently), so the backend adding a channel is exactly the case
 * where the map has no entry and the compiler cannot warn. That path has to
 * degrade to a generic icon and the raw value, not render nothing or crash on
 * `cfg.icon` being undefined.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChannelType } from '@/lib/types';
import { ChannelIcon, channelLabel } from './channel-icon';

/** A channel the frontend's map has never heard of, as the API could send. */
const UNKNOWN = 'TELEGRAM' as ChannelType;

describe('ChannelIcon', () => {
  it.each([
    ['WHATSAPP', 'WhatsApp', 'emerald'],
    ['INSTAGRAM', 'Instagram', 'pink'],
    ['SMS', 'SMS', 'sky'],
    ['WEB_CHAT', 'Web Chat', 'violet'],
    ['EMAIL', 'Email', 'amber'],
  ])('renders %s with its own label and colour', (channel, label, hue) => {
    render(<ChannelIcon channel={channel as ChannelType} />);
    const badge = screen.getByTitle(label);
    expect(badge.className).toContain(`text-${hue}-600`);
    expect(badge.className).toContain(`bg-${hue}-50`);
  });

  it('gives every known channel a distinct colour', () => {
    // The icon is the only channel cue in a dense inbox row, so two channels
    // sharing a swatch would make them indistinguishable at a glance.
    const channels: ChannelType[] = ['WHATSAPP', 'INSTAGRAM', 'SMS', 'WEB_CHAT', 'EMAIL'];
    const classes = channels.map((c) => {
      const { unmount } = render(<ChannelIcon channel={c} />);
      const cls = document.querySelector('span[title]')!.className;
      unmount();
      return cls;
    });
    expect(new Set(classes).size).toBe(channels.length);
  });

  it('falls back to a neutral icon for a channel the map has no entry for', () => {
    render(<ChannelIcon channel={UNKNOWN} />);
    // Labelled with the raw value — an operator sees "TELEGRAM", not a blank.
    const badge = screen.getByTitle('TELEGRAM');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).toContain('bg-muted');
  });

  it('still renders an icon element on the fallback path', () => {
    // `const Icon = cfg.icon` would be undefined without the fallback object,
    // and React throws on rendering an undefined component type.
    const { container } = render(<ChannelIcon channel={UNKNOWN} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('merges a caller className without dropping the channel colour', () => {
    render(<ChannelIcon channel="WHATSAPP" className="h-8 w-8" />);
    const badge = screen.getByTitle('WhatsApp');
    expect(badge.className).toContain('h-8');
    expect(badge.className).toContain('text-emerald-600');
  });
});

describe('channelLabel', () => {
  it('maps every known channel to its display name', () => {
    expect(channelLabel('WHATSAPP')).toBe('WhatsApp');
    expect(channelLabel('WEB_CHAT')).toBe('Web Chat');
    expect(channelLabel('SMS')).toBe('SMS');
  });

  it('returns the raw value for an unmapped channel', () => {
    expect(channelLabel(UNKNOWN)).toBe('TELEGRAM');
  });
});
