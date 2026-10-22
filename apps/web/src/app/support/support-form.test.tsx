import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getParam = vi.fn<(key: string) => string | null>(() => null);
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: getParam }),
}));

const submitTicket = vi.fn();
vi.mock('@/lib/support-ticket', async (orig) => ({
  ...(await orig<typeof import('@/lib/support-ticket')>()),
  submitTicket: (...args: unknown[]) => submitTicket(...args),
}));

import { SupportForm } from './support-form';

function fill() {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Asha' } });
  fireEvent.change(screen.getByLabelText('Email or phone'), { target: { value: 'asha@example.com' } });
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Refund' } });
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'My refund has not arrived yet.' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  submitTicket.mockReset();
  getParam.mockReset();
  getParam.mockReturnValue(null);
});

describe('SupportForm', () => {
  it('needs no login and shows validation errors on an empty submit', () => {
    render(<SupportForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit ticket' }));
    expect(screen.getByText('Please tell us your name.')).toBeInTheDocument();
    expect(submitTicket).not.toHaveBeenCalled();
  });

  it('files the ticket on the widget named in ?w= and shows the reference', async () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'https://api.example.com');
    getParam.mockImplementation((k) => (k === 'w' ? 'widget-123' : null));
    submitTicket.mockResolvedValue({ reference: 'AB12CD34' });

    render(<SupportForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit ticket' }));

    expect(await screen.findByText('#AB12CD34')).toBeInTheDocument();
    expect(submitTicket).toHaveBeenCalledWith(
      expect.objectContaining({ wsUrl: 'https://api.example.com', widgetId: 'widget-123' }),
    );
    const wa = screen.getByRole('link', { name: 'Save to WhatsApp' });
    expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=.*AB12CD34/);
  });

  it('falls back to the feedback endpoint when no widget is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<SupportForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit ticket' }));

    await screen.findByText('Ticket received');
    expect(submitTicket).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/feedback');
    expect(JSON.parse(init.body)).toMatchObject({ type: 'general', email: 'asha@example.com' });
  });

  it('keeps the form and shows the error when submission fails', async () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'https://api.example.com');
    getParam.mockImplementation((k) => (k === 'w' ? 'widget-123' : null));
    const { TicketSubmitError } = await import('@/lib/support-ticket');
    submitTicket.mockRejectedValue(new TicketSubmitError('Widget not found'));

    render(<SupportForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Submit ticket' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Widget not found'));
    expect(screen.getByLabelText('Your name')).toHaveValue('Asha');
  });
});
