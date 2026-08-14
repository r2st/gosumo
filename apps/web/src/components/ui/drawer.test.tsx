import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Drawer } from './drawer';

function renderDrawer(props: Partial<React.ComponentProps<typeof Drawer>> = {}) {
  const onClose = vi.fn();
  const view = render(
    <Drawer open onClose={onClose} title="Order GS-1042" {...props}>
      <p>drawer body</p>
    </Drawer>,
  );
  return { ...view, onClose };
}

describe('Drawer', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <Drawer open={false} onClose={vi.fn()} title="Order GS-1042">
        <p>drawer body</p>
      </Drawer>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the title and body when open', () => {
    renderDrawer();
    expect(screen.getByText('Order GS-1042')).toBeInTheDocument();
    expect(screen.getByText('drawer body')).toBeInTheDocument();
  });

  it('renders an optional description', () => {
    renderDrawer({ description: 'Placed 14 Aug 2026' });
    expect(screen.getByText('Placed 14 Aug 2026')).toBeInTheDocument();
  });

  it('renders an optional footer', () => {
    renderDrawer({ footer: <button>Refund</button> });
    expect(screen.getByText('Refund')).toBeInTheDocument();
  });

  it('omits the footer region entirely when none is given', () => {
    const { container } = renderDrawer();
    expect(container.querySelector('.border-t')).toBeNull();
  });

  it('is announced as a modal dialog', () => {
    renderDrawer();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  describe('dismissal', () => {
    it('closes from the close button', () => {
      const { onClose } = renderDrawer();
      fireEvent.click(screen.getByLabelText('Close'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('closes on a backdrop click', () => {
      const { onClose, container } = renderDrawer();
      fireEvent.click(container.querySelector('.absolute.inset-0') as Element);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('closes on Escape', () => {
      const { onClose } = renderDrawer();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('ignores other keys', () => {
      const { onClose } = renderDrawer();
      fireEvent.keyDown(window, { key: 'Enter' });
      fireEvent.keyDown(window, { key: 'a' });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not close on a click inside the panel', () => {
      const { onClose } = renderDrawer();
      fireEvent.click(screen.getByText('drawer body'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('the Escape listener', () => {
    it('is not registered while closed', () => {
      const onClose = vi.fn();
      render(
        <Drawer open={false} onClose={onClose} title="t">
          <p>body</p>
        </Drawer>,
      );
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('is removed on unmount, so a closed drawer cannot swallow Escape', () => {
      // A leaked window listener would keep firing onClose on every Escape
      // press for the rest of the session.
      const { onClose, unmount } = renderDrawer();
      unmount();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });

    it('is removed when the drawer closes', () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <Drawer open onClose={onClose} title="t">
          <p>body</p>
        </Drawer>,
      );
      rerender(
        <Drawer open={false} onClose={onClose} title="t">
          <p>body</p>
        </Drawer>,
      );
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('anchors to the right edge', () => {
    const { container } = renderDrawer();
    expect(container.firstElementChild?.className).toContain('justify-end');
  });

  it('merges a caller className onto the panel', () => {
    renderDrawer({ className: 'max-w-3xl' });
    expect(screen.getByRole('dialog').className).toContain('max-w-3xl');
  });

  it('truncates a long title rather than pushing the close button off-panel', () => {
    renderDrawer({ title: 'A'.repeat(200) });
    expect(screen.getByRole('heading').className).toContain('truncate');
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });
});
