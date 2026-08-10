import { parseBrokerCommand, parseIndianMoneyToPaise } from './broker-command.parser';

describe('parseIndianMoneyToPaise', () => {
  it('parses lakh shorthand', () => {
    expect(parseIndianMoneyToPaise('94L')).toBe(94 * 1e5 * 100);
    expect(parseIndianMoneyToPaise('94 lakh')).toBe(94 * 1e5 * 100);
    expect(parseIndianMoneyToPaise('94.5 lac')).toBe(Math.round(94.5 * 1e5 * 100));
  });

  it('parses crore shorthand', () => {
    expect(parseIndianMoneyToPaise('1.2 Cr')).toBe(Math.round(1.2 * 1e7 * 100));
    expect(parseIndianMoneyToPaise('2crore')).toBe(2 * 1e7 * 100);
  });

  it('parses thousands and plain rupees', () => {
    expect(parseIndianMoneyToPaise('50k')).toBe(50 * 1e3 * 100);
    expect(parseIndianMoneyToPaise('9400000')).toBe(9_400_000 * 100);
    expect(parseIndianMoneyToPaise('94,00,000')).toBe(9_400_000 * 100);
  });

  it('returns null for junk', () => {
    expect(parseIndianMoneyToPaise('cheap')).toBeNull();
    expect(parseIndianMoneyToPaise('')).toBeNull();
  });
});

describe('parseBrokerCommand', () => {
  it('parses pause / stop follow-ups', () => {
    expect(parseBrokerCommand('pause follow-ups for Rahul')).toEqual({
      kind: 'PAUSE_FOLLOWUPS',
      leadName: 'Rahul',
    });
    expect(parseBrokerCommand('stop followups for Priya Sharma')).toEqual({
      kind: 'PAUSE_FOLLOWUPS',
      leadName: 'Priya Sharma',
    });
  });

  it('parses resume follow-ups', () => {
    expect(parseBrokerCommand('resume follow ups for Neha')).toEqual({
      kind: 'RESUME_FOLLOWUPS',
      leadName: 'Neha',
    });
  });

  it('parses lead assignment', () => {
    expect(parseBrokerCommand('assign Rahul to Amit')).toEqual({
      kind: 'ASSIGN_LEAD',
      leadName: 'Rahul',
      agentName: 'Amit',
    });
    expect(parseBrokerCommand('assign lead Priya Sharma to Deepa')).toEqual({
      kind: 'ASSIGN_LEAD',
      leadName: 'Priya Sharma',
      agentName: 'Deepa',
    });
  });

  it('parses a price update', () => {
    expect(parseBrokerCommand('Serene Heights 2BHK now 94L')).toEqual({
      kind: 'UPDATE_PRICE',
      project: 'Serene Heights',
      config: '2BHK',
      pricePaise: 94 * 1e5 * 100,
    });
    expect(parseBrokerCommand('Lake View 3 BHK is now 1.2 Cr')).toEqual({
      kind: 'UPDATE_PRICE',
      project: 'Lake View',
      config: '3BHK',
      pricePaise: Math.round(1.2 * 1e7 * 100),
    });
  });

  it('parses a book-visit command and splits name from time', () => {
    expect(parseBrokerCommand('book visit for Neha tomorrow 5pm')).toEqual({
      kind: 'BOOK_VISIT',
      leadName: 'Neha',
      when: 'tomorrow 5pm',
    });
    expect(parseBrokerCommand('book a site visit for Rahul Kumar today at 3:30pm')).toEqual({
      kind: 'BOOK_VISIT',
      leadName: 'Rahul Kumar',
      when: 'today at 3:30pm',
    });
  });

  it('prefers specific commands over the loose price pattern', () => {
    // "assign ... to ..." must not be read as a price update.
    expect(parseBrokerCommand('assign Rahul to Amit')!.kind).toBe('ASSIGN_LEAD');
  });

  it('returns null when nothing matches', () => {
    expect(parseBrokerCommand('good morning team')).toBeNull();
    expect(parseBrokerCommand('')).toBeNull();
  });
});
