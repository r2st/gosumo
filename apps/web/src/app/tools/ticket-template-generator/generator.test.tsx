import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TicketTemplateGenerator } from './generator';

describe('TicketTemplateGenerator', () => {
  it('renders the title and category buttons', () => {
    render(<TicketTemplateGenerator />);
    expect(screen.getByText('Ticket Template Generator')).toBeInTheDocument();
    expect(screen.getByText('Bug Report')).toBeInTheDocument();
    expect(screen.getByText('Feature Request')).toBeInTheDocument();
  });

  it('shows template preview after selecting a category', () => {
    render(<TicketTemplateGenerator />);
    fireEvent.click(screen.getByText('Bug Report'));
    expect(screen.getByText('Template Preview')).toBeInTheDocument();
    expect(screen.getByText('Copy Template')).toBeInTheDocument();
  });

  it('displays correct priority for selected category', () => {
    render(<TicketTemplateGenerator />);
    fireEvent.click(screen.getByText('General Inquiry'));
    expect(screen.getByText('Low')).toBeInTheDocument();
  });
});
