import { fireEvent, render, screen } from '@testing-library/react';
import { KeyRound } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationCredential, TestConnectionResult } from '@/lib/integration-types';

const saveMutate = vi.fn();
const testMutate = vi.fn();
let save = { mutate: saveMutate, isPending: false, isSuccess: false };
let test = { mutate: testMutate, isPending: false };
let canManage = true;

vi.mock('@/hooks/use-integrations', () => ({
  useSaveIntegration: () => save,
  useTestIntegration: () => test,
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ canManage }),
}));

import { IntegrationCard, type IntegrationDef } from './integration-card';

const DEF: IntegrationDef = {
  provider: 'RAZORPAY',
  label: 'Razorpay',
  blurb: 'Collect UPI and card payments',
  icon: KeyRound,
  color: 'bg-sky-600',
  fields: [
    { name: 'keyId', label: 'Key ID', placeholder: 'rzp_live_…' },
    { name: 'keySecret', label: 'Key secret', secret: true },
    {
      name: 'mode',
      label: 'Mode',
      options: [
        { label: 'Test', value: 'test' },
        { label: 'Live', value: 'live' },
      ],
    },
    {
      name: 'webhookSecret',
      label: 'Webhook secret',
      secret: true,
      visibleWhen: { field: 'mode', equals: 'live' },
    },
  ],
};

function credential(overrides: Partial<IntegrationCredential> = {}): IntegrationCredential {
  return {
    provider: 'RAZORPAY',
    status: 'CONNECTED',
    configured: true,
    fields: {
      keyId: { set: true, value: 'rzp_live_abc' },
      keySecret: { set: true, last4: '9f2a' },
      mode: { set: true, value: 'test' },
    },
    ...overrides,
  };
}

function renderCard(cred?: IntegrationCredential) {
  return render(<IntegrationCard def={DEF} credential={cred} />);
}

function keyIdInput() {
  return screen.getByPlaceholderText('rzp_live_…');
}

describe('IntegrationCard', () => {
  beforeEach(() => {
    saveMutate.mockClear();
    testMutate.mockClear();
    save = { mutate: saveMutate, isPending: false, isSuccess: false };
    test = { mutate: testMutate, isPending: false };
    canManage = true;
  });

  describe('presentation', () => {
    it('renders the provider identity', () => {
      renderCard();
      expect(screen.getByText('Razorpay')).toBeInTheDocument();
      expect(screen.getByText('Collect UPI and card payments')).toBeInTheDocument();
    });

    it('reads "Not connected" with no stored credential', () => {
      renderCard();
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    it('reads "Connected" once configured', () => {
      renderCard(credential());
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('falls back to the configured flag when the API sends no status', () => {
      renderCard(credential({ status: undefined as never, configured: true }));
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });

    it('surfaces the provider error message', () => {
      // Without this the operator sees a red "Error" badge and no reason for it.
      renderCard(credential({ status: 'ERROR', errorMessage: 'Invalid API key' }));
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Invalid API key')).toBeInTheDocument();
    });

    it('says when it was last tested', () => {
      renderCard(credential({ lastTestedAt: '2026-08-14T08:00:00.000Z' }));
      expect(screen.getByText(/Last tested/)).toBeInTheDocument();
    });

    it('says "Not tested yet" when it never has been', () => {
      renderCard(credential());
      expect(screen.getByText('Not tested yet')).toBeInTheDocument();
    });
  });

  describe('field rendering', () => {
    it('echoes back stored non-secret values', () => {
      renderCard(credential());
      expect(keyIdInput()).toHaveValue('rzp_live_abc');
    });

    it('never renders a stored secret, only its last4 hint', () => {
      renderCard(credential());
      expect(screen.getByText('••••••••9f2a')).toBeInTheDocument();
    });

    it('defaults a select to its first option when nothing is stored', () => {
      renderCard();
      expect(screen.getByRole('combobox')).toHaveValue('test');
    });

    it('hides a conditional field until its trigger matches', () => {
      renderCard();
      expect(screen.queryByText('Webhook secret')).not.toBeInTheDocument();
    });

    it('reveals a conditional field once the trigger matches', () => {
      renderCard();
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'live' } });
      expect(screen.getByText('Webhook secret')).toBeInTheDocument();
    });
  });

  describe('dirty tracking', () => {
    it('starts clean, so Save is disabled', () => {
      renderCard(credential());
      expect(screen.getByText('Save').closest('button')).toBeDisabled();
    });

    it('becomes dirty when a non-secret field changes', () => {
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_xyz' } });
      expect(screen.getByText('Save').closest('button')).toBeEnabled();
    });

    it('becomes dirty when a secret is filled in', () => {
      // A secret always starts blank, so "changed from initial" can never
      // detect it — filling it at all is the signal.
      const { container } = renderCard(credential());
      const secret = container.querySelector('input[type="password"]') as HTMLInputElement;
      fireEvent.change(secret, { target: { value: 'new-secret' } });
      expect(screen.getByText('Save').closest('button')).toBeEnabled();
    });

    it('goes clean again when an edit is reverted', () => {
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'changed' } });
      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_abc' } });
      expect(screen.getByText('Save').closest('button')).toBeDisabled();
    });

    it('ignores a hidden conditional field when deciding dirtiness', () => {
      renderCard(credential());
      expect(screen.getByText('Save').closest('button')).toBeDisabled();
    });
  });

  describe('saving', () => {
    it('sends the provider and the filled credentials', () => {
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_xyz' } });
      fireEvent.click(screen.getByText('Save'));
      expect(saveMutate).toHaveBeenCalledWith({
        provider: 'RAZORPAY',
        body: { credentials: { keyId: 'rzp_live_xyz', mode: 'test' } },
      });
    });

    it('omits a blank secret, so saving does not wipe the stored one', () => {
      // The API treats an absent key as "keep what you have"; sending "" would
      // clear a working credential on every unrelated edit.
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_xyz' } });
      fireEvent.click(screen.getByText('Save'));
      expect(saveMutate.mock.calls[0][0].body.credentials).not.toHaveProperty('keySecret');
    });

    it('includes a secret that was filled in', () => {
      const { container } = renderCard(credential());
      const secret = container.querySelector('input[type="password"]') as HTMLInputElement;
      fireEvent.change(secret, { target: { value: 'new-secret' } });
      fireEvent.click(screen.getByText('Save'));
      expect(saveMutate.mock.calls[0][0].body.credentials.keySecret).toBe('new-secret');
    });

    it('omits fields hidden by their condition', () => {
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'x' } });
      fireEvent.click(screen.getByText('Save'));
      expect(saveMutate.mock.calls[0][0].body.credentials).not.toHaveProperty('webhookSecret');
    });

    it('confirms a save once the form is clean again', () => {
      save = { mutate: saveMutate, isPending: false, isSuccess: true };
      renderCard(credential());
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });

    it('hides the stale confirmation as soon as the form is edited again', () => {
      save = { mutate: saveMutate, isPending: false, isSuccess: true };
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'edited' } });
      expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    });
  });

  describe('testing the connection', () => {
    it('is disabled for an unconfigured, untouched integration', () => {
      // There is nothing to test yet — the request would just 400.
      renderCard();
      expect(screen.getByText('Test connection').closest('button')).toBeDisabled();
    });

    it('is enabled once something has been typed', () => {
      renderCard();
      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_new' } });
      expect(screen.getByText('Test connection').closest('button')).toBeEnabled();
    });

    it('is enabled for an already-configured integration', () => {
      renderCard(credential());
      expect(screen.getByText('Test connection').closest('button')).toBeEnabled();
    });

    it('sends the current form values, not just the stored ones', () => {
      renderCard(credential());
      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_xyz' } });
      fireEvent.click(screen.getByText('Test connection'));
      expect(testMutate.mock.calls[0][0]).toEqual({
        provider: 'RAZORPAY',
        body: { credentials: { keyId: 'rzp_live_xyz', mode: 'test' } },
      });
    });

    it('reports a successful result with its latency', () => {
      testMutate.mockImplementation((_vars, opts) =>
        opts.onSuccess({ success: true, message: 'Reached Razorpay', latencyMs: 412 }),
      );
      renderCard(credential());
      fireEvent.click(screen.getByText('Test connection'));
      expect(screen.getByText(/Reached Razorpay/)).toBeInTheDocument();
      expect(screen.getByText(/412ms/)).toBeInTheDocument();
    });

    it('reports a failure', () => {
      testMutate.mockImplementation((_vars, opts) =>
        opts.onSuccess({ success: false, message: 'Authentication failed' } as TestConnectionResult),
      );
      renderCard(credential());
      fireEvent.click(screen.getByText('Test connection'));
      expect(screen.getByText(/Authentication failed/)).toBeInTheDocument();
    });

    it('omits the latency when the API does not report one', () => {
      testMutate.mockImplementation((_vars, opts) =>
        opts.onSuccess({ success: true, message: 'OK' } as TestConnectionResult),
      );
      renderCard(credential());
      fireEvent.click(screen.getByText('Test connection'));
      expect(screen.queryByText(/ms\)/)).not.toBeInTheDocument();
    });

    it('clears a previous result when the form is submitted', () => {
      // A stale "✓ Reached Razorpay" beside newly-typed credentials claims
      // they were verified when they were not.
      testMutate.mockImplementation((_vars, opts) =>
        opts.onSuccess({ success: true, message: 'Reached Razorpay' } as TestConnectionResult),
      );
      renderCard(credential());
      fireEvent.click(screen.getByText('Test connection'));
      expect(screen.getByText(/Reached Razorpay/)).toBeInTheDocument();

      fireEvent.change(keyIdInput(), { target: { value: 'rzp_live_xyz' } });
      fireEvent.click(screen.getByText('Save'));
      expect(screen.queryByText(/Reached Razorpay/)).not.toBeInTheDocument();
    });
  });

  describe('permissions', () => {
    it('hides Save and Test from an operator who cannot manage integrations', () => {
      // PUT /integrations/credentials/:provider is @Roles(MANAGER); showing the
      // buttons would just produce a 403.
      canManage = false;
      renderCard(credential());
      expect(screen.queryByText('Save')).not.toBeInTheDocument();
      expect(screen.queryByText('Test connection')).not.toBeInTheDocument();
    });

    it('still shows the configuration read-only', () => {
      canManage = false;
      renderCard(credential());
      expect(keyIdInput()).toHaveValue('rzp_live_abc');
    });

    it('disables the fields for a non-manager', () => {
      canManage = false;
      const { container } = renderCard(credential());
      expect(container.querySelector('fieldset')).toBeDisabled();
    });

    it('leaves the fields editable for a manager', () => {
      const { container } = renderCard(credential());
      expect(container.querySelector('fieldset')).not.toBeDisabled();
    });
  });

  describe('re-syncing after a save', () => {
    it('rebuilds the form when the stored credential changes', () => {
      // A save clears the secret inputs server-side; the card must pick up the
      // new stored values rather than keep showing the old draft.
      const { rerender } = render(<IntegrationCard def={DEF} credential={credential()} />);
      fireEvent.change(keyIdInput(), { target: { value: 'draft-value' } });

      rerender(
        <IntegrationCard
          def={DEF}
          credential={credential({
            fields: {
              keyId: { set: true, value: 'rzp_live_saved' },
              keySecret: { set: true, last4: '1234' },
              mode: { set: true, value: 'test' },
            },
          })}
        />,
      );
      expect(keyIdInput()).toHaveValue('rzp_live_saved');
    });

    it('does not rebuild when an unrelated prop changes', () => {
      const { rerender } = render(<IntegrationCard def={DEF} credential={credential()} />);
      fireEvent.change(keyIdInput(), { target: { value: 'draft-value' } });
      rerender(<IntegrationCard def={DEF} credential={credential({ lastTestedAt: 'x' })} />);
      expect(keyIdInput()).toHaveValue('draft-value');
    });
  });
});
