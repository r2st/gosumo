import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SurveyBuilder } from './builder';

describe('SurveyBuilder', () => {
  it('renders the title and survey type options', () => {
    render(<SurveyBuilder />);
    expect(screen.getByText('Customer Satisfaction Survey Builder')).toBeInTheDocument();
    expect(screen.getByText('Post-Ticket Survey')).toBeInTheDocument();
    expect(screen.getByText('Net Promoter Score (NPS)')).toBeInTheDocument();
  });

  it('shows questions after selecting a survey type', () => {
    render(<SurveyBuilder />);
    fireEvent.click(screen.getByText('Post-Ticket Survey'));
    expect(screen.getByText('Questions')).toBeInTheDocument();
    expect(screen.getByText('Copy Survey')).toBeInTheDocument();
  });

  it('displays NPS questions when NPS type is selected', () => {
    render(<SurveyBuilder />);
    fireEvent.click(screen.getByText('Net Promoter Score (NPS)'));
    expect(screen.getByDisplayValue('How likely are you to recommend us to a friend or colleague?')).toBeInTheDocument();
  });
});
