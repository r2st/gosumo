import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SecretInput } from './masked-input';

function renderInput(props: Partial<React.ComponentProps<typeof SecretInput>> = {}) {
  const onChange = vi.fn();
  const view = render(<SecretInput value="" onChange={onChange} id="secret" {...props} />);
  return { ...view, onChange, field: () => screen.getByLabelText('secret', { selector: 'input' }) };
}

/** The field is the only input in the tree. */
function field() {
  return document.querySelector('input') as HTMLInputElement;
}

describe('SecretInput', () => {
  it('masks the value by default', () => {
    renderInput({ value: 'sk_live_123' });
    expect(field()).toHaveAttribute('type', 'password');
  });

  it('reports what the operator types', () => {
    const { onChange } = renderInput();
    fireEvent.change(field(), { target: { value: 'sk_live_abc' } });
    expect(onChange).toHaveBeenCalledWith('sk_live_abc');
  });

  it('opts out of autofill, so a password manager cannot stuff an API key here', () => {
    renderInput();
    expect(field()).toHaveAttribute('autocomplete', 'off');
  });

  describe('reveal toggle', () => {
    it('is hidden while the field is empty, since there is nothing to reveal', () => {
      renderInput({ value: '' });
      expect(screen.queryByLabelText('Show secret')).not.toBeInTheDocument();
    });

    it('appears once something is typed', () => {
      renderInput({ value: 'sk_live_123' });
      expect(screen.getByLabelText('Show secret')).toBeInTheDocument();
    });

    it('unmasks the field and flips its own label', () => {
      renderInput({ value: 'sk_live_123' });
      fireEvent.click(screen.getByLabelText('Show secret'));
      expect(field()).toHaveAttribute('type', 'text');
      expect(screen.getByLabelText('Hide secret')).toBeInTheDocument();
    });

    it('re-masks on a second click', () => {
      renderInput({ value: 'sk_live_123' });
      fireEvent.click(screen.getByLabelText('Show secret'));
      fireEvent.click(screen.getByLabelText('Hide secret'));
      expect(field()).toHaveAttribute('type', 'password');
    });

    it('is skipped by tab, so it never sits between the field and Save', () => {
      renderInput({ value: 'sk_live_123' });
      expect(screen.getByLabelText('Show secret')).toHaveAttribute('tabindex', '-1');
    });

    it('does not submit the surrounding settings form', () => {
      renderInput({ value: 'sk_live_123' });
      expect(screen.getByLabelText('Show secret')).toHaveAttribute('type', 'button');
    });
  });

  describe('an already-stored secret', () => {
    it('starts empty, so the real secret never reaches the DOM', () => {
      // The API is write-only for secrets; rendering the stored value would put
      // a live credential in the page source.
      renderInput({ configured: true, last4: '4242' });
      expect(field()).toHaveValue('');
    });

    it('explains that leaving the field blank keeps the current secret', () => {
      renderInput({ configured: true, last4: '4242' });
      expect(field()).toHaveAttribute('placeholder', 'Leave blank to keep current secret');
    });

    it('hints at the stored secret by its last four characters', () => {
      renderInput({ configured: true, last4: '4242' });
      expect(screen.getByText('••••••••4242')).toBeInTheDocument();
      expect(screen.getByText('· stored securely')).toBeInTheDocument();
    });

    it('falls back to dots when the API sends no last4', () => {
      renderInput({ configured: true });
      expect(screen.getByText('••••••••••••')).toBeInTheDocument();
    });

    it('drops the hint once a replacement is typed', () => {
      // Keeping "stored securely" beside a freshly typed key implies the old
      // one is still what will be saved.
      renderInput({ configured: true, last4: '4242', value: 'sk_live_new' });
      expect(screen.queryByText(/stored securely/)).not.toBeInTheDocument();
    });
  });

  describe('an unconfigured secret', () => {
    it('shows the caller placeholder', () => {
      renderInput({ placeholder: 'sk_live_…' });
      expect(field()).toHaveAttribute('placeholder', 'sk_live_…');
    });

    it('shows no stored-secret hint', () => {
      renderInput({ placeholder: 'sk_live_…' });
      expect(screen.queryByText(/stored securely/)).not.toBeInTheDocument();
    });
  });

  it('takes an id so a label can point at it', () => {
    renderInput({ id: 'razorpay-secret' });
    expect(field()).toHaveAttribute('id', 'razorpay-secret');
  });
});
