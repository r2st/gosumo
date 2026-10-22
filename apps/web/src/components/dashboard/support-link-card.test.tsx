import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const useChannels = vi.fn();
vi.mock('@/hooks/use-settings', () => ({ useChannels: () => useChannels() }));

import { SupportLinkCard, supportLinkFor } from './support-link-card';

const channel = (over: Record<string, unknown>) => ({ id: 'ch-1', type: 'WEB_CHAT', status: 'CONNECTED', ...over });

beforeEach(() => useChannels.mockReset());

describe('SupportLinkCard', () => {
  it('prompts to connect Web Chat when there is none', () => {
    useChannels.mockReturnValue({ data: { data: [channel({ type: 'WHATSAPP' })] }, isLoading: false, isError: false });
    render(<SupportLinkCard />);
    expect(screen.getByRole('link', { name: 'Connect Web Chat' })).toHaveAttribute('href', '/settings/channels');
  });

  it('shows the public ticket link and a WhatsApp share for it', () => {
    useChannels.mockReturnValue({ data: { data: [channel({})] }, isLoading: false, isError: false });
    render(<SupportLinkCard />);

    expect(screen.getByLabelText('Support link')).toHaveValue(supportLinkFor('ch-1'));
    const share = screen.getByRole('link', { name: /Share on WhatsApp/ });
    expect(decodeURIComponent(share.getAttribute('href')!)).toContain('https://desk.doaide.com/support?w=ch-1');
  });

  it('sends the link straight to a customer number', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    useChannels.mockReturnValue({ data: { data: [channel({})] }, isLoading: false, isError: false });
    render(<SupportLinkCard />);

    const send = screen.getByRole('button', { name: /Send link/ });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Customer WhatsApp number'), { target: { value: '+91 98765 43210' } });
    fireEvent.click(send);
    expect(open.mock.calls[0][0]).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    open.mockRestore();
  });

  it('renders nothing while channels load', () => {
    useChannels.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = render(<SupportLinkCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
