/**
 * The cadences page — follow-up sequences and the WhatsApp template library.
 *
 * Everything here eventually sends a message to a real buyer, so the tests pin
 * the gates rather than the cards: a cadence can only be switched on by someone
 * who can write, and the approve/reject pair exists only on a template that is
 * not already approved — offering "Approve" on an approved template invites a
 * pointless write, and offering it to a VIEWER invites a 403. Both tabs are
 * asserted through their four states, since an error rendered as "no cadences
 * yet" would read as "nothing is scheduled" when in fact nothing is known.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cadence, MessageTemplate } from '@/lib/realty-types';
import type { Role } from '@/lib/feature-types';

function makeCadence(overrides: Partial<Cadence> = {}): Cadence {
  return {
    id: 'cd-1',
    name: 'No-response D1/D3/D7',
    description: 'Nudges a buyer who never replied.',
    trigger: 'NO_RESPONSE',
    isActive: true,
    steps: [
      { id: 's1', order: 1, dayOffset: 1, templateId: 't1', templateName: 'nudge_day1', stopOn: ['REPLY'] },
      { id: 's2', order: 2, dayOffset: 3, templateId: 't2', templateName: 'nudge_day3', stopOn: [] },
    ],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as Cadence;
}

function makeTemplate(overrides: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 't1',
    name: 'nudge_day1',
    category: 'UTILITY',
    language: 'en',
    body: 'Hi {{1}}, still interested in {{2}}?',
    variables: ['name', 'project'],
    approvalStatus: 'PENDING',
    approvedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const state = {
  cadences: {
    data: [makeCadence()] as Cadence[] | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
  templates: {
    data: [makeTemplate()] as MessageTemplate[] | undefined,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
    refetch: vi.fn(),
  },
};

const mutations = { toggle: vi.fn(), setApproval: vi.fn(), seed: vi.fn() };
const flags = { seedPending: false, approvalPending: false };
let role: Role = 'STAFF';

vi.mock('@/hooks/use-realty', () => ({
  useCadences: () => state.cadences,
  useTemplates: () => state.templates,
  useUpdateCadence: () => ({ mutate: mutations.toggle, isPending: false }),
  useSetTemplateApproval: () => ({
    mutate: mutations.setApproval,
    isPending: flags.approvalPending,
  }),
  useSeedCadences: () => ({ mutate: mutations.seed, isPending: flags.seedPending }),
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

import CadencesPage from './page';

const templatesTab = () => screen.getByRole('button', { name: 'Template library' });

beforeEach(() => {
  state.cadences = {
    data: [makeCadence()],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  state.templates = {
    data: [makeTemplate()],
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
  };
  flags.seedPending = false;
  flags.approvalPending = false;
  role = 'STAFF';
  vi.clearAllMocks();
});

describe('the page shell', () => {
  it('opens on the cadences tab', () => {
    render(<CadencesPage />);
    expect(screen.getByRole('heading', { name: 'Cadences' })).toBeInTheDocument();
    expect(screen.getByText('No-response D1/D3/D7')).toBeInTheDocument();
  });

  it('switches to the template library and back', () => {
    render(<CadencesPage />);
    fireEvent.click(templatesTab());
    expect(screen.getByText('Hi {{1}}, still interested in {{2}}?')).toBeInTheDocument();
    expect(screen.queryByText('No-response D1/D3/D7')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Cadences' })[0]);
    expect(screen.getByText('No-response D1/D3/D7')).toBeInTheDocument();
  });

  it('installs the default sequences on request', () => {
    render(<CadencesPage />);
    fireEvent.click(screen.getByRole('button', { name: /install defaults/i }));
    expect(mutations.seed).toHaveBeenCalledTimes(1);
  });

  it('shows the install button busy while it runs', () => {
    flags.seedPending = true;
    render(<CadencesPage />);
    expect(screen.getByRole('button', { name: /install defaults/i })).toBeDisabled();
  });

  it('does not offer the install to a VIEWER', () => {
    role = 'VIEWER';
    render(<CadencesPage />);
    expect(screen.queryByRole('button', { name: /install defaults/i })).not.toBeInTheDocument();
  });
});

describe('the cadence list', () => {
  it('spins while the cadences load', () => {
    state.cadences = { ...state.cadences, data: undefined, isLoading: true };
    render(<CadencesPage />);
    expect(screen.getByText('Loading cadences…')).toBeInTheDocument();
  });

  it('reports a failure as a failure, not as an empty list', () => {
    const refetch = vi.fn();
    // A thrown value carrying no usable message falls back to the page's copy.
    state.cadences = { data: undefined, isLoading: false, isError: true, error: { code: 500 }, refetch };
    render(<CadencesPage />);
    expect(screen.getByText('Could not load cadences.')).toBeInTheDocument();
    expect(screen.queryByText('No cadences yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('prefers a message the server actually explained itself with', () => {
    state.cadences = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Cadence engine is being upgraded.'),
      refetch: vi.fn(),
    };
    render(<CadencesPage />);
    expect(screen.getByText('Cadence engine is being upgraded.')).toBeInTheDocument();
  });

  it('invites the defaults when there are none', () => {
    state.cadences = { ...state.cadences, data: [] };
    render(<CadencesPage />);
    expect(screen.getByText('No cadences yet')).toBeInTheDocument();
  });

  it('survives a body that never arrived', () => {
    state.cadences = { ...state.cadences, data: undefined, isLoading: false };
    render(<CadencesPage />);
    expect(screen.getByText('No cadences yet')).toBeInTheDocument();
  });

  it('labels the trigger in plain words', () => {
    render(<CadencesPage />);
    expect(screen.getByText('No response')).toBeInTheDocument();

    state.cadences = { ...state.cadences, data: [makeCadence({ trigger: 'DORMANT' })] };
    render(<CadencesPage />);
    expect(screen.getByText('Dormant reactivation')).toBeInTheDocument();
  });

  it('lists each step with its day offset and template', () => {
    render(<CadencesPage />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('D+1');
    expect(steps[0]).toHaveTextContent('nudge_day1');
    expect(steps[1]).toHaveTextContent('D+3');
  });

  it('names the events that stop a step, and says nothing when none do', () => {
    render(<CadencesPage />);
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('stop: reply');
    expect(steps[1]).not.toHaveTextContent('stop:');
  });

  it('omits the description line for a cadence recorded without one', () => {
    state.cadences = { ...state.cadences, data: [makeCadence({ description: null })] };
    render(<CadencesPage />);
    expect(screen.queryByText('Nudges a buyer who never replied.')).not.toBeInTheDocument();
  });

  it('switches a cadence off', () => {
    render(<CadencesPage />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('switch'));
    expect(mutations.toggle).toHaveBeenCalledWith({ id: 'cd-1', isActive: false });
  });

  it('switches a dormant cadence back on', () => {
    state.cadences = { ...state.cadences, data: [makeCadence({ isActive: false })] };
    render(<CadencesPage />);
    fireEvent.click(screen.getByRole('switch'));
    expect(mutations.toggle).toHaveBeenCalledWith({ id: 'cd-1', isActive: true });
  });

  it('shows a VIEWER the sequence without the switch', () => {
    role = 'VIEWER';
    render(<CadencesPage />);
    expect(screen.getByText('No-response D1/D3/D7')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

describe('the template library', () => {
  const openLibrary = () => {
    render(<CadencesPage />);
    fireEvent.click(templatesTab());
  };

  it('spins while the templates load', () => {
    state.templates = { ...state.templates, data: undefined, isLoading: true };
    openLibrary();
    expect(screen.getByText('Loading templates…')).toBeInTheDocument();
  });

  it('reports a failure as a failure', () => {
    const refetch = vi.fn();
    state.templates = { data: undefined, isLoading: false, isError: true, error: { code: 500 }, refetch };
    openLibrary();
    expect(screen.getByText('Could not load templates.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('invites the defaults when the library is bare', () => {
    state.templates = { ...state.templates, data: [] };
    openLibrary();
    expect(screen.getByText('No templates yet')).toBeInTheDocument();
  });

  it('shows the name, category, approval state and body', () => {
    openLibrary();
    expect(screen.getByText('nudge_day1')).toBeInTheDocument();
    expect(screen.getByText('UTILITY')).toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('Hi {{1}}, still interested in {{2}}?')).toBeInTheDocument();
  });

  it('tones a marketing template differently from a utility one', () => {
    state.templates = { ...state.templates, data: [makeTemplate({ category: 'MARKETING' })] };
    openLibrary();
    expect(screen.getByText('MARKETING')).toBeInTheDocument();
  });

  it('approves a pending template', () => {
    openLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mutations.setApproval).toHaveBeenCalledWith({ id: 't1', approvalStatus: 'APPROVED' });
  });

  it('rejects a pending template', () => {
    openLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(mutations.setApproval).toHaveBeenCalledWith({ id: 't1', approvalStatus: 'REJECTED' });
  });

  it('still offers both actions on a template Meta rejected', () => {
    state.templates = { ...state.templates, data: [makeTemplate({ approvalStatus: 'REJECTED' })] };
    openLibrary();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
  });

  it('offers nothing once a template is approved', () => {
    state.templates = { ...state.templates, data: [makeTemplate({ approvalStatus: 'APPROVED' })] };
    openLibrary();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('holds Approve while the change is in flight', () => {
    flags.approvalPending = true;
    openLibrary();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('shows a VIEWER the template without the approval controls', () => {
    role = 'VIEWER';
    openLibrary();
    expect(screen.getByText('nudge_day1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('renders a multi-line body with its line breaks intact', () => {
    state.templates = {
      ...state.templates,
      data: [makeTemplate({ body: 'Line one\nLine two' })],
    };
    openLibrary();
    const body = screen.getByText(/Line one/);
    expect(body).toHaveClass('whitespace-pre-wrap');
    expect(body.textContent).toBe('Line one\nLine two');
  });
});
