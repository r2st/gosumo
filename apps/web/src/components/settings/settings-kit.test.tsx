import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  FormRow,
  ReadOnlyFieldset,
  ReadOnlyNotice,
  SaveButton,
  SettingsCard,
} from './settings-kit';

describe('SettingsCard', () => {
  it('renders the title and body', () => {
    render(
      <SettingsCard title="Business profile">
        <p>body</p>
      </SettingsCard>,
    );
    expect(screen.getByText('Business profile')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders an optional description', () => {
    render(
      <SettingsCard title="Business profile" description="Shown to your buyers">
        <p>body</p>
      </SettingsCard>,
    );
    expect(screen.getByText('Shown to your buyers')).toBeInTheDocument();
  });

  it('renders an optional footer', () => {
    render(
      <SettingsCard title="t" footer={<button>Save</button>}>
        <p>body</p>
      </SettingsCard>,
    );
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('omits the footer bar when there is no footer', () => {
    const { container } = render(
      <SettingsCard title="t">
        <p>body</p>
      </SettingsCard>,
    );
    expect(container.querySelector('.border-t')).toBeNull();
  });
});

describe('SaveButton', () => {
  it('is enabled once the form is dirty', () => {
    render(<SaveButton />);
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('submits the surrounding form', () => {
    render(<SaveButton />);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('is disabled while the form is untouched, so a no-op save cannot fire', () => {
    render(<SaveButton dirty={false} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled while the mutation is in flight', () => {
    render(<SaveButton isPending />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('stays disabled while pending even on a dirty form', () => {
    // Otherwise a double-click sends the settings write twice.
    render(<SaveButton isPending dirty />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('confirms a successful save', () => {
    render(<SaveButton isSuccess />);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('reports a failed save', () => {
    render(<SaveButton isError />);
    expect(screen.getByText('Couldn’t save')).toBeInTheDocument();
  });

  it('hides a stale success message once a new save starts', () => {
    // The previous "Saved" beside a spinner claims the in-flight write already
    // landed.
    render(<SaveButton isSuccess isPending />);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('hides a stale error once a retry starts', () => {
    render(<SaveButton isError isPending />);
    expect(screen.queryByText('Couldn’t save')).not.toBeInTheDocument();
  });

  it('accepts custom label text', () => {
    render(<SaveButton>Update plan</SaveButton>);
    expect(screen.getByText('Update plan')).toBeInTheDocument();
  });

  it('forwards other button props', () => {
    const onClick = vi.fn();
    render(<SaveButton onClick={onClick} variant="danger" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('ReadOnlyFieldset', () => {
  it('leaves controls interactive for an operator who can save', () => {
    render(
      <ReadOnlyFieldset readOnly={false}>
        <input aria-label="name" />
        <button>Save</button>
      </ReadOnlyFieldset>,
    );
    expect(screen.getByLabelText('name')).toBeEnabled();
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('disables every control inside when read-only', () => {
    // The point of a native disabled fieldset is that a control added later is
    // covered without anyone remembering to gate it — fail closed.
    render(
      <ReadOnlyFieldset readOnly>
        <input aria-label="name" />
        <select aria-label="plan">
          <option>Pro</option>
        </select>
        <textarea aria-label="notes" />
        <button>Save</button>
      </ReadOnlyFieldset>,
    );
    expect(screen.getByLabelText('name')).toBeDisabled();
    expect(screen.getByLabelText('plan')).toBeDisabled();
    expect(screen.getByLabelText('notes')).toBeDisabled();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('disables via the native fieldset attribute, not a per-control prop', () => {
    // The browser suppresses clicks on descendants of a disabled fieldset, so
    // the attribute is the whole mechanism. (jsdom does not model that
    // suppression, which is why this asserts the attribute rather than
    // firing a click.)
    const { container } = render(
      <ReadOnlyFieldset readOnly>
        <button>Save</button>
      </ReadOnlyFieldset>,
    );
    expect(container.querySelector('fieldset')).toBeDisabled();
  });

  it('leaves the fieldset enabled when not read-only', () => {
    const { container } = render(
      <ReadOnlyFieldset readOnly={false}>
        <button>Save</button>
      </ReadOnlyFieldset>,
    );
    expect(container.querySelector('fieldset')).not.toBeDisabled();
  });

  it('stays out of the layout by default', () => {
    const { container } = render(
      <ReadOnlyFieldset readOnly={false}>
        <input aria-label="name" />
      </ReadOnlyFieldset>,
    );
    expect(container.querySelector('fieldset')?.className).toBe('contents');
  });

  it('accepts a layout class for the multi-card case', () => {
    // `space-y-*` compiles to a sibling selector over real DOM children, so
    // wrapping several cards needs the spacing moved onto the fieldset — left
    // as `contents`, the gaps collapse.
    const { container } = render(
      <ReadOnlyFieldset readOnly className="space-y-6">
        <div>card one</div>
        <div>card two</div>
      </ReadOnlyFieldset>,
    );
    expect(container.querySelector('fieldset')?.className).toBe('space-y-6');
  });
});

describe('ReadOnlyNotice', () => {
  it('explains why the form is inert', () => {
    render(<ReadOnlyNotice />);
    expect(screen.getByText(/read-only access/)).toBeInTheDocument();
  });

  it('accepts custom copy for a surface with a more specific reason', () => {
    render(<ReadOnlyNotice>Billing is managed by the account owner.</ReadOnlyNotice>);
    expect(screen.getByText(/managed by the account owner/)).toBeInTheDocument();
  });
});

describe('FormRow', () => {
  it('renders its children', () => {
    render(
      <FormRow>
        <input aria-label="a" />
        <input aria-label="b" />
      </FormRow>,
    );
    expect(screen.getByLabelText('a')).toBeInTheDocument();
    expect(screen.getByLabelText('b')).toBeInTheDocument();
  });

  it('stacks to one column on mobile before pairing up', () => {
    // A bare `grid` with two columns blows out the viewport at 375px.
    const { container } = render(
      <FormRow>
        <input aria-label="a" />
      </FormRow>,
    );
    expect(container.firstElementChild?.className).toContain('sm:grid-cols-2');
  });
});
