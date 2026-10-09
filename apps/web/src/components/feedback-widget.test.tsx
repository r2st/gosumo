import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FeedbackWidget } from './feedback-widget';

describe('FeedbackWidget', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the floating trigger button', () => {
    render(<FeedbackWidget />);
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeInTheDocument();
  });

  it('opens the modal when the trigger is clicked', () => {
    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Send Feedback')).toBeInTheDocument();
  });

  it('disables Send when message is empty', () => {
    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('enables Send when a message is entered', () => {
    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.change(screen.getByPlaceholderText("Tell us what's on your mind..."), {
      target: { value: 'Great app!' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('submits feedback and shows success message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );

    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.change(screen.getByPlaceholderText("Tell us what's on your mind..."), {
      target: { value: 'Love it!' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Thanks for your feedback!')).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/feedback', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"message":"Love it!"'),
    }));
  });

  it('shows error message on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
    );

    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.change(screen.getByPlaceholderText("Tell us what's on your mind..."), {
      target: { value: 'Bug report' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Server error');
    });
  });

  it('allows selecting feedback type', () => {
    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    const bugRadio = screen.getByRole('radio', { name: 'Bug Report' });
    expect(bugRadio).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(bugRadio);
    expect(bugRadio).toHaveAttribute('aria-checked', 'true');
  });

  it('sends the selected type in the request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );

    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Feature Request' }));
    fireEvent.change(screen.getByPlaceholderText("Tell us what's on your mind..."), {
      target: { value: 'Add dark mode' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Thanks for your feedback!')).toBeInTheDocument();
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.type).toBe('feature');
  });

  it('resets the form when reopened after success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );

    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.change(screen.getByPlaceholderText("Tell us what's on your mind..."), {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Thanks for your feedback!')).toBeInTheDocument();
    });

    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));

    expect(screen.queryByText('Thanks for your feedback!')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Tell us what's on your mind...")).toHaveValue('');
  });
});
