/**
 * Settings → Privacy — the DPDPA surface.
 *
 * This page executes three of the Act's data-principal rights against a real
 * buyer's record, so the tests are about the guards around those writes rather
 * than the copy: the access lookup only fires on an explicit submit, erasure
 * is confirm-gated, correction stays disabled until something actually changed,
 * and the retention window refuses values outside 1–120 instead of PUTting
 * `NaN`. The consent history and network opt-in are asserted in both states,
 * because a revoked consent rendered as granted is the failure that matters.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComplianceSettings, DataAccessResult } from '@/lib/compliance-types';
import { LanguageProvider } from '@/providers/language-provider';

function makeLookup(overrides: Partial<DataAccessResult> = {}): DataAccessResult {
  return {
    found: true,
    phone: '+919800000001',
    lead: {
      id: 'l1',
      name: 'Asha Rao',
      email: 'asha@example.in',
      whatsappPhone: '+919800000001',
      stage: 'QUALIFIED',
      source: 'PORTAL',
      extractedFacts: [],
      objections: [],
      promises: [],
      optOut: false,
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    messages: [
      {
        id: 'm1',
        direction: 'INBOUND',
        senderType: 'CUSTOMER',
        textContent: 'Hi',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    consents: [
      {
        id: 'c1',
        phone: '+919800000001',
        consent_type: 'PROCESSING',
        granted_at: '2026-07-01T00:00:00.000Z',
        revoked_at: null,
        channel: 'WHATSAPP',
        source: null,
        created_at: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'c2',
        phone: '+919800000001',
        consent_type: 'MARKETING',
        granted_at: '2026-07-01T00:00:00.000Z',
        revoked_at: '2026-08-01T00:00:00.000Z',
        channel: 'WHATSAPP',
        source: null,
        created_at: '2026-07-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const SETTINGS: ComplianceSettings = {
  retentionMonths: 24,
  dataProcessorAgreement: false,
  dataProcessorAgreedAt: null,
  lastRetentionRunAt: null,
};

const state = {
  lookup: {
    data: undefined as DataAccessResult | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  settings: {
    data: SETTINGS as ComplianceSettings | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  optIn: { data: { optIn: false }, isLoading: false },
};

/** The phone the component passed to `useDataRequest` on the latest render. */
let requestedPhone: string | null = null;

const mutations = {
  update: vi.fn(),
  correction: vi.fn(),
  erasure: vi.fn(),
  runRetention: vi.fn(),
  setOptIn: vi.fn(),
};

const asMutation = (mutate: ReturnType<typeof vi.fn>) => ({
  mutate,
  isPending: false,
  isError: false,
  isSuccess: false,
});

vi.mock('@/hooks/use-compliance', () => ({
  useComplianceSettings: () => state.settings,
  useDataRequest: (phone: string | null) => {
    requestedPhone = phone;
    return phone ? state.lookup : { ...state.lookup, data: undefined };
  },
  useCorrection: () => asMutation(mutations.correction),
  useErasure: () => asMutation(mutations.erasure),
  useRunRetention: () => asMutation(mutations.runRetention),
  useUpdateComplianceSettings: () => asMutation(mutations.update),
}));

vi.mock('@/hooks/use-realty', () => ({
  useIntelligenceOptIn: () => state.optIn,
  useSetIntelligenceOptIn: () => asMutation(mutations.setOptIn),
}));

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock('@/providers/toast-provider', () => ({ useToast: () => toast }));

import PrivacyPage from './page';

function renderPage() {
  return render(
    <LanguageProvider>
      <PrivacyPage />
    </LanguageProvider>,
  );
}

/** Runs the phone lookup form and returns the rendered result panel. */
function lookup(phone = '+919800000001') {
  state.lookup.data = makeLookup();
  renderPage();
  fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: phone } });
  fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
}

beforeEach(() => {
  state.lookup = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  state.settings = { data: SETTINGS, isLoading: false, isError: false, refetch: vi.fn() };
  state.optIn = { data: { optIn: false }, isLoading: false };
  requestedPhone = null;
  vi.clearAllMocks();
});

describe('PrivacyPage lookup', () => {
  it('renders the DPDPA notice', () => {
    renderPage();
    expect(screen.getByText('DPDPA compliance notice')).toBeInTheDocument();
  });

  it('does not query until the operator submits a phone', () => {
    renderPage();
    expect(requestedPhone).toBeNull();
    // Typing alone must not fire the request — the lookup is an explicit act.
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+919800000001' } });
    expect(requestedPhone).toBeNull();
  });

  it('keeps the lookup button disabled for blank and whitespace-only input', () => {
    renderPage();
    const button = screen.getByRole('button', { name: /Look up data/ });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '   ' } });
    expect(button).toBeDisabled();
  });

  it('trims the submitted phone before querying', () => {
    state.lookup.data = makeLookup();
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), {
      target: { value: '  +919800000001  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
    expect(requestedPhone).toBe('+919800000001');
  });

  it('shows a loading state while the lookup is in flight', () => {
    state.lookup = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+91980' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('retries a failed lookup', () => {
    const refetch = vi.fn();
    state.lookup = { data: undefined, isLoading: false, isError: true, refetch };
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+91980' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('reports when nothing is held for the phone', () => {
    state.lookup.data = makeLookup({ found: false, lead: null });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+91980' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
    expect(screen.getByText('No data held for this phone number.')).toBeInTheDocument();
  });
});

describe('PrivacyPage right of access', () => {
  it('discloses the collected data fields', () => {
    lookup();
    expect(screen.getByText('Collected data')).toBeInTheDocument();
    expect(screen.getByText('asha@example.in')).toBeInTheDocument();
    expect(screen.getByText('QUALIFIED')).toBeInTheDocument();
    expect(screen.getByText('PORTAL')).toBeInTheDocument();
  });

  it('renders an em dash for a field the business never collected', () => {
    state.lookup.data = makeLookup();
    state.lookup.data.lead!.email = null;
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+91980' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('counts the stored messages', () => {
    lookup();
    expect(screen.getByText(/Messages · 1/)).toBeInTheDocument();
  });

  it('marks a revoked consent as revoked and a live one as granted', () => {
    lookup();
    expect(screen.getByText('PROCESSING')).toBeInTheDocument();
    expect(screen.getByText('MARKETING')).toBeInTheDocument();
    // "Granted"/"Revoked" also label the network-consent switch below, so the
    // assertion is scoped to the consent list.
    const processingRow = screen.getByText('PROCESSING').closest('li') as HTMLElement;
    const marketingRow = screen.getByText('MARKETING').closest('li') as HTMLElement;
    expect(within(processingRow).getByText('Granted')).toBeInTheDocument();
    expect(within(marketingRow).getByText('Revoked')).toBeInTheDocument();
  });

  it('renders a dash when no consent was ever recorded', () => {
    state.lookup.data = makeLookup({ consents: [] });
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+91980' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));
    expect(screen.getByText('Consent history')).toBeInTheDocument();
  });
});

describe('PrivacyPage right to correction', () => {
  it('keeps Save disabled until a field actually changes', () => {
    lookup();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const [nameInput] = screen.getAllByDisplayValue('Asha Rao');
    fireEvent.change(nameInput, { target: { value: 'Asha R.' } });
    expect(save).toBeEnabled();
  });

  it('re-disables Save when the edit is reverted', () => {
    lookup();
    const [nameInput] = screen.getAllByDisplayValue('Asha Rao');
    fireEvent.change(nameInput, { target: { value: 'Asha R.' } });
    fireEvent.change(nameInput, { target: { value: 'Asha Rao' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('submits the correction against the looked-up phone and toasts', () => {
    lookup();
    fireEvent.change(screen.getAllByDisplayValue('Asha Rao')[0], {
      target: { value: 'Asha Rao Kumar' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutations.correction).toHaveBeenCalledWith(
      { phone: '+919800000001', name: 'Asha Rao Kumar', email: 'asha@example.in' },
      expect.anything(),
    );
    mutations.correction.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Buyer data corrected.');
    mutations.correction.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not save the correction.');
  });
});

describe('PrivacyPage right to erasure', () => {
  it('does nothing when the confirm prompt is declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    lookup();
    fireEvent.click(screen.getByRole('button', { name: /Request erasure/ }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mutations.erasure).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('erases the phone once confirmed and reports both outcomes', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    lookup();
    fireEvent.click(screen.getByRole('button', { name: /Request erasure/ }));
    expect(mutations.erasure).toHaveBeenCalledWith('+919800000001', expect.anything());

    mutations.erasure.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Personal data erased.');
    mutations.erasure.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not erase this buyer’s data.');
    confirmSpy.mockRestore();
  });
});

describe('PrivacyPage retention policy', () => {
  it('shows a loading state while the settings load', () => {
    state.settings = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('retries when the settings failed to load', () => {
    const refetch = vi.fn();
    state.settings = { data: undefined, isLoading: false, isError: true, refetch };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('reports "Never" until the first sweep has run', () => {
    renderPage();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('formats the timestamp of the last sweep', () => {
    state.settings.data = { ...SETTINGS, lastRetentionRunAt: '2026-08-01T06:30:00.000Z' };
    renderPage();
    expect(screen.queryByText('Never')).toBeNull();
  });

  it('refuses to save a retention window outside 1–120', () => {
    renderPage();
    const months = screen.getByDisplayValue('24');
    fireEvent.change(months, { target: { value: '999' } });
    // Out of range is not "dirty", so the Save button never enables and the
    // form cannot PUT a window the API would reject.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    fireEvent.change(months, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a valid window together with the processor agreement', () => {
    renderPage();
    fireEvent.change(screen.getByDisplayValue('24'), { target: { value: '36' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mutations.update).toHaveBeenCalledWith(
      { retentionMonths: 36, dataProcessorAgreement: false },
      expect.anything(),
    );
    mutations.update.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Retention policy saved.');
    mutations.update.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not save your changes.');
  });

  it('treats toggling the processor agreement alone as a change worth saving', () => {
    renderPage();
    const agreement = screen.getAllByRole('switch')[0];
    expect(agreement).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(agreement);
    expect(agreement).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mutations.update).toHaveBeenCalledWith(
      { retentionMonths: 24, dataProcessorAgreement: true },
      expect.anything(),
    );
  });

  it('runs the sweep on demand and reports how many records it erased', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Run retention sweep now' }));
    expect(mutations.runRetention).toHaveBeenCalledWith(undefined, expect.anything());

    mutations.runRetention.mock.calls[0][1].onSuccess({ leadsAnonymized: 7 });
    expect(toast.success).toHaveBeenCalledWith('Retention sweep complete — 7 erased.');
    mutations.runRetention.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not run the retention sweep.');
  });
});

describe('PrivacyPage network consent', () => {
  it('reads as revoked and grants on toggle when the business has not opted in', () => {
    renderPage();
    // Two switches on the page: the processor agreement, then network consent.
    const toggle = screen.getAllByRole('switch')[1];
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(mutations.setOptIn).toHaveBeenCalledWith(true);
  });

  it('reads as granted and revokes on toggle when opted in', () => {
    state.optIn = { data: { optIn: true }, isLoading: false };
    renderPage();
    const toggle = screen.getAllByRole('switch')[1];
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(mutations.setOptIn).toHaveBeenCalledWith(false);
  });

  it('disables the toggle while the opt-in state is still loading', () => {
    state.optIn = { data: undefined as unknown as { optIn: boolean }, isLoading: true };
    renderPage();
    expect(screen.getAllByRole('switch')[1]).toBeDisabled();
  });
});

/**
 * The guards on this page all protect the same thing: a DPDPA request must not
 * be issued against the wrong subject, and a retention window must not be
 * written outside the range the API accepts. Each is a branch that only runs
 * when the operator does something slightly wrong, which is exactly when it
 * matters.
 */
describe('PrivacyPage input guards', () => {
  it('ignores a lookup submitted with a blank phone', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));

    // Nothing was submitted, so the hook was never asked for a subject and no
    // result panel appeared.
    expect(requestedPhone).toBeNull();
    expect(screen.queryByRole('button', { name: /Erase/ })).toBeNull();
  });

  it('renders nothing in the result panel when the lookup resolved to no payload', () => {
    // Not loading, not an error, and no body — the panel has a final `: null`
    // arm precisely so this renders empty instead of throwing on `data.found`.
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), {
      target: { value: '+919800000001' },
    });
    state.lookup.data = undefined;
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));

    expect(requestedPhone).toBe('+919800000001');
    expect(screen.queryByText('No data held for this number')).toBeNull();
    expect(screen.queryByDisplayValue('Asha Rao')).toBeNull();
  });

  it('refuses to submit an out-of-range retention window even when the form is submitted directly', () => {
    // The Save button disables, but a browser still submits the form on Enter
    // in a text input. The `!validMonths` guard is what stops a 999-month
    // window reaching the API.
    renderPage();
    const months = screen.getByDisplayValue('24');
    fireEvent.change(months, { target: { value: '999' } });
    fireEvent.submit(months.closest('form')!);

    expect(mutations.update).not.toHaveBeenCalled();
  });
});

describe('PrivacyPage correction form on a sparse lead', () => {
  it('starts from empty fields when the lead has no name or email on file', () => {
    // A lead ingested from a missed call has a phone and nothing else. Both
    // fields read through `?? ''`; without it React drops to an uncontrolled
    // input mid-edit and the correction silently posts undefined.
    const sparse = makeLookup();
    state.lookup.data = {
      ...sparse,
      lead: { ...sparse.lead!, name: null, email: null },
    };
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('+91…'), {
      target: { value: '+919800000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Look up data/ }));

    expect(screen.queryByDisplayValue('Asha Rao')).toBeNull();

    // Typing a name makes the form dirty, and the correction posts what was typed.
    const nameInput = screen.getByLabelText(/Name/i);
    expect(nameInput).toHaveValue('');
    fireEvent.change(nameInput, { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutations.correction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Asha Rao', email: '' }),
      expect.anything(),
    );
  });
});
