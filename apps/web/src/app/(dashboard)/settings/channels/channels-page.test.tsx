/**
 * Settings → Channels — the channel management UI.
 *
 * This page is where an operator wires a real WhatsApp/Instagram/SMS account
 * into GoSumo, so the tests focus on the parts that are dangerous to get
 * wrong: credentials must never be rendered in full, the three role tiers on
 * this page (connect/disconnect/test are MANAGER, the enable toggle is STAFF)
 * must gate the right controls, and per-channel test results must not bleed
 * across rows.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Channel } from '@/lib/feature-types';
import type { Role } from '@/lib/feature-types';

let currentRole: Role | null = 'MANAGER';

const authValue = () => ({
  status: 'authenticated' as const,
  user: currentRole
    ? {
        id: 'u1',
        email: 'me@acme.in',
        name: 'Me',
        role: currentRole,
        businessId: 'b1',
        twoFactorEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }
    : null,
  business: null,
});

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue(),
  useOptionalAuth: () => authValue(),
}));

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    businessId: 'b1',
    type: 'WHATSAPP',
    displayName: 'Main WhatsApp',
    status: 'CONNECTED',
    accountId: '919999900001',
    webhookUrl: 'https://api.gosumo.in/v1/webhooks/whatsapp',
    metadata: {},
    lastMessageAt: '2026-08-14T04:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-14T04:00:00.000Z',
    ...overrides,
  } as Channel;
}

const state = {
  channels: {
    data: { data: [makeChannel()] as Channel[] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  connect: { mutate: vi.fn(), isPending: false, isError: false },
  disconnect: { mutate: vi.fn(), isPending: false },
  toggle: { mutate: vi.fn(), isPending: false },
  test: { mutate: vi.fn(), isPending: false },
  embed: { mutate: vi.fn(), isPending: false, isError: false },
};

vi.mock('@/hooks/use-settings', () => ({
  useChannels: () => state.channels,
  useConnectChannel: () => state.connect,
  useDisconnectChannel: () => state.disconnect,
}));

vi.mock('@/hooks/use-channels', () => ({
  useTestChannel: () => state.test,
  useWebChatEmbed: () => state.embed,
  useToggleChannel: () => state.toggle,
}));

const ChannelsPage = (await import('./page')).default;

beforeEach(() => {
  currentRole = 'MANAGER';
  state.channels = {
    data: { data: [makeChannel()] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  state.connect = { mutate: vi.fn(), isPending: false, isError: false };
  state.disconnect = { mutate: vi.fn(), isPending: false };
  state.toggle = { mutate: vi.fn(), isPending: false };
  state.test = { mutate: vi.fn(), isPending: false };
  state.embed = { mutate: vi.fn(), isPending: false, isError: false };
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('ChannelsPage — load states', () => {
  it('shows a loading state while channels resolve', () => {
    state.channels.isLoading = true;
    const { container } = render(<ChannelsPage />);
    expect(container.textContent).toContain('Loading');
  });

  it('shows an error state with a retry', () => {
    state.channels.isError = true;
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(state.channels.refetch).toHaveBeenCalled();
  });

  it('hides the connected section when nothing is connected yet', () => {
    state.channels.data = { data: [] };
    render(<ChannelsPage />);

    expect(screen.queryByText('Connected channels')).not.toBeInTheDocument();
    expect(screen.getByText('Available channels')).toBeInTheDocument();
  });
});

describe('ChannelsPage — connected channel rows', () => {
  it('shows the display name, account and status', () => {
    render(<ChannelsPage />);

    expect(screen.getByText('Main WhatsApp')).toBeInTheDocument();
    expect(screen.getByText(/919999900001/)).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it.each([
    ['DISCONNECTED', 'Disconnected'],
    ['PENDING', 'Pending'],
    ['ERROR', 'Error'],
    ['RATE_LIMITED', 'Rate limited'],
  ] as const)('labels a %s channel as "%s"', (status, label) => {
    state.channels.data = { data: [makeChannel({ status })] };
    render(<ChannelsPage />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('surfaces the gateway error message on a broken channel', () => {
    state.channels.data = {
      data: [
        makeChannel({
          status: 'ERROR',
          errorMessage: 'Meta access token expired',
        }),
      ],
    };
    render(<ChannelsPage />);

    expect(screen.getByText(/Meta access token expired/)).toBeInTheDocument();
  });

  it('omits the last-message suffix for a channel that never received one', () => {
    state.channels.data = { data: [makeChannel({ lastMessageAt: undefined })] };
    render(<ChannelsPage />);

    expect(screen.queryByText(/last message/)).not.toBeInTheDocument();
  });

  it('shows the webhook URL for a webhook-driven channel', () => {
    render(<ChannelsPage />);
    expect(screen.getByText('https://api.gosumo.in/v1/webhooks/whatsapp')).toBeInTheDocument();
  });

  it('shows no webhook block for Web Chat, which has none', () => {
    state.channels.data = {
      data: [makeChannel({ type: 'WEB_CHAT', displayName: 'Site widget' })],
    };
    render(<ChannelsPage />);

    expect(screen.queryByText('Webhook URL')).not.toBeInTheDocument();
  });

  it('copies the webhook URL and confirms it', async () => {
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Copy URL/ }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'https://api.gosumo.in/v1/webhooks/whatsapp',
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});

describe('ChannelsPage — credential masking', () => {
  it('never renders more than the last 4 characters of a token', () => {
    // The full access token must not reach the DOM — it would be readable in
    // a screenshot, a screen-share, or a support session.
    const secret = 'EAAG9ZBxxSECRETxxTOKEN7h2k';
    state.channels.data = {
      data: [makeChannel({ metadata: { accessTokenLast4: secret } })],
    };
    const { container } = render(<ChannelsPage />);

    expect(container.textContent).not.toContain(secret);
    expect(screen.getByText(/••••••••7h2k · stored securely/)).toBeInTheDocument();
  });

  it('fully masks a credential too short to safely reveal a tail of', () => {
    state.channels.data = {
      data: [makeChannel({ metadata: { apiKeyLast4: 'abc' } })],
    };
    const { container } = render(<ChannelsPage />);

    expect(container.textContent).not.toContain('abc');
    expect(screen.getByText(/•••••••• · stored securely/)).toBeInTheDocument();
  });

  it('falls back through the metadata key variants', () => {
    state.channels.data = {
      data: [makeChannel({ metadata: { credentialHint: 'twilio-sid-9911' } })],
    };
    render(<ChannelsPage />);

    expect(screen.getByText(/••••••••9911/)).toBeInTheDocument();
  });

  it('shows no credential line when the channel carries no metadata', () => {
    state.channels.data = { data: [makeChannel({ metadata: {} })] };
    render(<ChannelsPage />);

    expect(screen.queryByText(/stored securely/)).not.toBeInTheDocument();
  });
});

describe('ChannelsPage — connection test', () => {
  it('reports a verified connection with its latency', () => {
    state.test.mutate = vi.fn((_id, opts) =>
      opts?.onSuccess?.({ success: true, message: 'ok', latencyMs: 143 }),
    );
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Test/ }));

    expect(state.test.mutate).toHaveBeenCalledWith('ch-1', expect.anything());
    expect(screen.getByText('Connection verified (143ms)')).toBeInTheDocument();
  });

  it('reports the gateway message on a failed test', () => {
    state.test.mutate = vi.fn((_id, opts) =>
      opts?.onSuccess?.({ success: false, message: 'Invalid phone number id', latencyMs: 0 }),
    );
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Test/ }));

    expect(screen.getByText('Invalid phone number id')).toBeInTheDocument();
  });

  it('falls back to a generic failure when the request itself errors', () => {
    state.test.mutate = vi.fn((_id, opts) => opts?.onError?.(new Error('network')));
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Test/ }));

    expect(screen.getByText('Test request failed')).toBeInTheDocument();
  });

  it('keeps each row’s test result on its own row', () => {
    // Results are keyed by channel id; a shared result would tell an operator
    // that a channel they never tested is healthy.
    state.channels.data = {
      data: [
        makeChannel({ id: 'ch-1', displayName: 'Main WhatsApp' }),
        makeChannel({ id: 'ch-2', type: 'SMS', displayName: 'SMS line' }),
      ],
    };
    state.test.mutate = vi.fn((id, opts) =>
      opts?.onSuccess?.({ success: true, message: 'ok', latencyMs: id === 'ch-1' ? 100 : 200 }),
    );
    render(<ChannelsPage />);

    fireEvent.click(screen.getAllByRole('button', { name: /Test/ })[0]);

    expect(screen.getByText('Connection verified (100ms)')).toBeInTheDocument();
    expect(screen.queryByText('Connection verified (200ms)')).not.toBeInTheDocument();
  });
});

describe('ChannelsPage — disconnect and toggle', () => {
  it('disconnects a channel by id', () => {
    render(<ChannelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    expect(state.disconnect.mutate).toHaveBeenCalledWith('ch-1');
  });

  it('toggles a connected channel off', () => {
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('switch'));

    expect(state.toggle.mutate).toHaveBeenCalledWith({ channelId: 'ch-1', enabled: false });
  });

  it('toggles a disconnected channel back on', () => {
    state.channels.data = { data: [makeChannel({ status: 'DISCONNECTED' })] };
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('switch'));

    expect(state.toggle.mutate).toHaveBeenCalledWith({ channelId: 'ch-1', enabled: true });
  });

  it('disables the toggle while a toggle is in flight', () => {
    state.toggle.isPending = true;
    render(<ChannelsPage />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

describe('ChannelsPage — available channels and connect', () => {
  it('offers all five channels', () => {
    render(<ChannelsPage />);
    const available = screen.getByText('Available channels').closest('section') ?? document.body;

    for (const label of ['WhatsApp', 'Instagram', 'SMS', 'Web Chat', 'Email']) {
      expect(within(available).getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('marks an already-connected type as Active and offers "Add another"', () => {
    render(<ChannelsPage />);

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add another/ })).toBeInTheDocument();
  });

  it('opens the connect modal with that channel’s fields', () => {
    state.channels.data = { data: [] };
    render(<ChannelsPage />);

    fireEvent.click(screen.getAllByRole('button', { name: /^Connect$/ })[0]);

    expect(screen.getByText('Connect WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Phone Number ID')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp Business Account ID')).toBeInTheDocument();
  });

  it('masks the token field so credentials are not shoulder-readable', () => {
    state.channels.data = { data: [] };
    const { container } = render(<ChannelsPage />);

    fireEvent.click(screen.getAllByRole('button', { name: /^Connect$/ })[0]);

    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('submits the typed credentials to that channel’s connect path', () => {
    state.channels.data = { data: [] };
    const { container } = render(<ChannelsPage />);

    fireEvent.click(screen.getAllByRole('button', { name: /^Connect$/ })[0]);

    const inputs = container.querySelectorAll('#connect-form input');
    fireEvent.change(inputs[0], { target: { value: 'Main WhatsApp' } });
    fireEvent.change(inputs[1], { target: { value: '10987654321' } });
    fireEvent.submit(container.querySelector('#connect-form')!);

    expect(state.connect.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/channels/whatsapp/connect',
        body: expect.objectContaining({
          displayName: 'Main WhatsApp',
          phoneNumberId: '10987654321',
        }),
      }),
      expect.anything(),
    );
  });

  it('reports a failed connection attempt inside the modal', () => {
    state.channels.data = { data: [] };
    state.connect.isError = true;
    render(<ChannelsPage />);

    fireEvent.click(screen.getAllByRole('button', { name: /^Connect$/ })[0]);

    expect(
      screen.getByText('Connection failed. Double-check your credentials.'),
    ).toBeInTheDocument();
  });
});

describe('ChannelsPage — Web Chat embed', () => {
  beforeEach(() => {
    state.channels.data = {
      data: [makeChannel({ id: 'ch-web', type: 'WEB_CHAT', displayName: 'Site widget' })],
    };
  });

  it('offers the embed button only for Web Chat', () => {
    render(<ChannelsPage />);
    expect(screen.getByRole('button', { name: /Get Embed Code/ })).toBeInTheDocument();
  });

  it('does not offer it for WhatsApp', () => {
    state.channels.data = { data: [makeChannel()] };
    render(<ChannelsPage />);
    expect(screen.queryByRole('button', { name: /Get Embed Code/ })).not.toBeInTheDocument();
  });

  it('renders the fetched snippet', () => {
    state.embed.mutate = vi.fn((_id, opts) =>
      opts?.onSuccess?.({ snippet: '<script src="https://cdn.gosumo.in/widget.js"></script>' }),
    );
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Get Embed Code/ }));

    expect(state.embed.mutate).toHaveBeenCalledWith('ch-web', expect.anything());
    expect(
      screen.getByText('<script src="https://cdn.gosumo.in/widget.js"></script>'),
    ).toBeInTheDocument();
  });

  it('reports a failure to fetch the snippet', () => {
    state.embed.isError = true;
    state.embed.mutate = vi.fn();
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Get Embed Code/ }));

    expect(screen.getByText(/Failed to fetch embed snippet/)).toBeInTheDocument();
  });

  it('copies the snippet to the clipboard', async () => {
    state.embed.mutate = vi.fn((_id, opts) => opts?.onSuccess?.({ snippet: '<script/>' }));
    render(<ChannelsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Get Embed Code/ }));
    fireEvent.click(screen.getByRole('button', { name: /Copy Snippet/ }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<script/>');
    expect(await screen.findByText(/Copied!/)).toBeInTheDocument();
  });
});

describe('ChannelsPage — role gating', () => {
  it('offers a VIEWER no controls at all', () => {
    currentRole = 'VIEWER';
    render(<ChannelsPage />);

    expect(screen.queryByRole('button', { name: /Test/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('gives STAFF the enable toggle but not connect/disconnect/test', () => {
    // PATCH /channels/:id/toggle carries no @Roles(), so it falls to the
    // guard's STAFF+ default — one rung below the MANAGER-only operations.
    currentRole = 'STAFF';
    render(<ChannelsPage />);

    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Test/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add another/ })).not.toBeInTheDocument();
  });

  it('gives a MANAGER everything', () => {
    currentRole = 'MANAGER';
    render(<ChannelsPage />);

    expect(screen.getByRole('button', { name: /Test/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('still shows a VIEWER the channel inventory and its health', () => {
    currentRole = 'VIEWER';
    render(<ChannelsPage />);

    expect(screen.getByText('Main WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });
});
