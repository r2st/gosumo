import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKey } from '@/lib/integration-types';

const refetch = vi.fn();
const createMutate = vi.fn();
const revokeMutate = vi.fn();

let keysQ: { data?: { data: ApiKey[] }; isLoading: boolean; isError: boolean; refetch: typeof refetch };
let create = { mutate: createMutate, isPending: false, isError: false };
let revoke = { mutate: revokeMutate, isPending: false };
let canManage = true;

vi.mock('@/hooks/use-integrations', () => ({
  useApiKeys: () => keysQ,
  useCreateApiKey: () => create,
  useRevokeApiKey: () => revoke,
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ canManage }),
}));

import { ApiKeysManager } from './api-keys-manager';

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k1',
    name: 'Zapier sync',
    prefix: 'gs_a1b2c3d',
    last4: '9f2a',
    scopes: ['conversations:read'],
    createdAt: '2026-07-01T10:00:00.000Z',
    lastUsedAt: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

function withKeys(keys: ApiKey[]) {
  keysQ = { data: { data: keys }, isLoading: false, isError: false, refetch };
}

describe('ApiKeysManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withKeys([key()]);
    create = { mutate: createMutate, isPending: false, isError: false };
    revoke = { mutate: revokeMutate, isPending: false };
    canManage = true;
  });

  describe('list states', () => {
    it('shows a loading state', () => {
      keysQ = { isLoading: true, isError: false, refetch };
      render(<ApiKeysManager />);
      expect(screen.queryByText('Zapier sync')).not.toBeInTheDocument();
    });

    it('offers a retry when the list fails', () => {
      keysQ = { isLoading: false, isError: true, refetch };
      render(<ApiKeysManager />);
      fireEvent.click(screen.getByText(/try again/i));
      expect(refetch).toHaveBeenCalled();
    });

    it('treats a missing payload as an error rather than an empty list', () => {
      // "No API keys yet" would tell the operator their keys were deleted.
      keysQ = { isLoading: false, isError: false, refetch };
      render(<ApiKeysManager />);
      expect(screen.queryByText('No API keys yet')).not.toBeInTheDocument();
    });

    it('shows an empty state when there are genuinely no keys', () => {
      withKeys([]);
      render(<ApiKeysManager />);
      expect(screen.getByText('No API keys yet')).toBeInTheDocument();
    });
  });

  describe('the key table', () => {
    it('lists a key by name', () => {
      render(<ApiKeysManager />);
      expect(screen.getByText('Zapier sync')).toBeInTheDocument();
    });

    it('shows only the prefix and last4, never the full secret', () => {
      render(<ApiKeysManager />);
      expect(screen.getByText('gs_a1b2c3d••••9f2a')).toBeInTheDocument();
    });

    it('lists the scopes', () => {
      render(<ApiKeysManager />);
      expect(screen.getByText('conversations:read')).toBeInTheDocument();
    });

    it('labels a scopeless key as full access', () => {
      // An empty scope array means unrestricted — rendering nothing there would
      // make the most dangerous key look like the most limited one.
      withKeys([key({ scopes: [] })]);
      render(<ApiKeysManager />);
      expect(screen.getByText('full access')).toBeInTheDocument();
    });

    it('truncates a long scope list to three plus a counter', () => {
      withKeys([
        key({
          scopes: ['a:read', 'b:read', 'c:read', 'd:read', 'e:read'],
        }),
      ]);
      render(<ApiKeysManager />);
      expect(screen.getByText('+2')).toBeInTheDocument();
      expect(screen.queryByText('d:read')).not.toBeInTheDocument();
    });

    it('shows no counter at exactly three scopes', () => {
      withKeys([key({ scopes: ['a:read', 'b:read', 'c:read'] })]);
      render(<ApiKeysManager />);
      expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    });

    it('says "never" for a key that has not been used', () => {
      withKeys([key({ lastUsedAt: null })]);
      render(<ApiKeysManager />);
      expect(screen.getByText('never')).toBeInTheDocument();
    });

    it('marks an expired key', () => {
      withKeys([key({ expiresAt: '2020-01-01T00:00:00.000Z' })]);
      render(<ApiKeysManager />);
      expect(screen.getByText('Expired')).toBeInTheDocument();
    });

    it('does not mark a key whose expiry is still ahead', () => {
      withKeys([key({ expiresAt: '2999-01-01T00:00:00.000Z' })]);
      render(<ApiKeysManager />);
      expect(screen.queryByText('Expired')).not.toBeInTheDocument();
    });

    it('does not mark a key with no expiry at all', () => {
      render(<ApiKeysManager />);
      expect(screen.queryByText('Expired')).not.toBeInTheDocument();
    });
  });

  describe('permissions', () => {
    it('hides minting and revoking from a non-manager', () => {
      // POST and DELETE are both @Roles(MANAGER); listing stays open.
      canManage = false;
      render(<ApiKeysManager />);
      expect(screen.queryByText('Generate key')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Revoke Zapier sync')).not.toBeInTheDocument();
    });

    it('still lists the keys for a non-manager', () => {
      canManage = false;
      render(<ApiKeysManager />);
      expect(screen.getByText('Zapier sync')).toBeInTheDocument();
    });
  });

  describe('generating a key', () => {
    function openCreate() {
      render(<ApiKeysManager />);
      fireEvent.click(screen.getByText('Generate key'));
    }

    it('opens the modal', () => {
      openCreate();
      expect(screen.getByText('Generate API key')).toBeInTheDocument();
    });

    it('requires a name before generating', () => {
      openCreate();
      expect(screen.getByText('Generate').closest('button')).toBeDisabled();
    });

    it('rejects a whitespace-only name', () => {
      openCreate();
      fireEvent.change(screen.getByPlaceholderText('My integration'), { target: { value: '   ' } });
      expect(screen.getByText('Generate').closest('button')).toBeDisabled();
    });

    it('enables generation once named', () => {
      openCreate();
      fireEvent.change(screen.getByPlaceholderText('My integration'), { target: { value: 'CRM' } });
      expect(screen.getByText('Generate').closest('button')).toBeEnabled();
    });

    it('starts with the least-privileged scope ticked', () => {
      openCreate();
      expect(screen.getByLabelText('Read conversations')).toBeChecked();
      expect(screen.getByLabelText('Send messages')).not.toBeChecked();
    });

    it('toggles a scope on and back off', () => {
      openCreate();
      const send = screen.getByLabelText('Send messages');
      fireEvent.click(send);
      expect(send).toBeChecked();
      fireEvent.click(send);
      expect(send).not.toBeChecked();
    });

    it('submits the name and chosen scopes', () => {
      openCreate();
      fireEvent.change(screen.getByPlaceholderText('My integration'), { target: { value: 'CRM' } });
      fireEvent.click(screen.getByLabelText('Read orders'));
      fireEvent.submit(document.getElementById('create-key-form') as HTMLFormElement);
      expect(createMutate.mock.calls[0][0]).toEqual({
        name: 'CRM',
        scopes: ['conversations:read', 'orders:read'],
      });
    });

    it('reports a failure without closing the modal', () => {
      create = { mutate: createMutate, isPending: false, isError: true };
      openCreate();
      expect(screen.getByText(/Couldn’t generate the key/)).toBeInTheDocument();
    });

    it('closes on cancel', () => {
      openCreate();
      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('Generate API key')).not.toBeInTheDocument();
    });
  });

  describe('revealing a newly-created key', () => {
    function generate(secret = 'gs_live_supersecretvalue') {
      createMutate.mockImplementation((_vars, opts) =>
        opts.onSuccess({ id: 'k2', name: 'CRM', prefix: 'gs_x', last4: 'aaaa', secret }),
      );
      render(<ApiKeysManager />);
      fireEvent.click(screen.getByText('Generate key'));
      fireEvent.change(screen.getByPlaceholderText('My integration'), { target: { value: 'CRM' } });
      fireEvent.submit(document.getElementById('create-key-form') as HTMLFormElement);
    }

    it('shows the full secret exactly once', () => {
      generate();
      expect(screen.getByText('gs_live_supersecretvalue')).toBeInTheDocument();
      expect(screen.getByText(/only time the full key is shown/)).toBeInTheDocument();
    });

    it('warns that no copy is kept', () => {
      generate();
      expect(screen.getByText(/we don’t keep a copy/)).toBeInTheDocument();
    });

    it('closes the create modal behind it', () => {
      generate();
      expect(screen.queryByText('Generate API key')).not.toBeInTheDocument();
    });

    it('dismisses on Done', () => {
      generate();
      fireEvent.click(screen.getByText('Done'));
      expect(screen.queryByText('gs_live_supersecretvalue')).not.toBeInTheDocument();
    });

    describe('the copy button', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: vi.fn().mockResolvedValue(undefined) },
          configurable: true,
        });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('writes the secret to the clipboard', () => {
        generate();
        fireEvent.click(screen.getByText('Copy'));
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('gs_live_supersecretvalue');
      });

      it('confirms, then reverts after two seconds', () => {
        generate();
        fireEvent.click(screen.getByText('Copy'));
        expect(screen.getByText('Copied')).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(2000);
        });
        expect(screen.getByText('Copy')).toBeInTheDocument();
      });
    });
  });

  describe('revoking a key', () => {
    function openRevoke() {
      render(<ApiKeysManager />);
      fireEvent.click(screen.getByLabelText('Revoke Zapier sync'));
    }

    it('asks for confirmation naming the key', () => {
      // Revoking hard-deletes and breaks every integration using it, so it must
      // never happen on a single click.
      openRevoke();
      expect(screen.getByText('Revoke API key')).toBeInTheDocument();
      expect(screen.getByText(/“Zapier sync” will stop working immediately/)).toBeInTheDocument();
    });

    it('warns that it cannot be undone', () => {
      openRevoke();
      expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    });

    it('does not revoke on cancel', () => {
      openRevoke();
      fireEvent.click(screen.getByText('Cancel'));
      expect(revokeMutate).not.toHaveBeenCalled();
      expect(screen.queryByText('Revoke API key')).not.toBeInTheDocument();
    });

    it('revokes by id on confirm', () => {
      openRevoke();
      fireEvent.click(screen.getByText('Revoke key'));
      expect(revokeMutate.mock.calls[0][0]).toBe('k1');
    });

    it('closes the dialog once the revoke succeeds', () => {
      revokeMutate.mockImplementation((_id, opts) => opts.onSuccess());
      openRevoke();
      fireEvent.click(screen.getByText('Revoke key'));
      expect(screen.queryByText('Revoke API key')).not.toBeInTheDocument();
    });

    it('keeps the dialog open while the revoke is in flight', () => {
      revoke = { mutate: revokeMutate, isPending: true };
      openRevoke();
      expect(screen.getByText('Revoke API key')).toBeInTheDocument();
    });
  });
});
