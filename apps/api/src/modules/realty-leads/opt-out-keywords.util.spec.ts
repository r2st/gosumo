import { isOptOutMessage, normalizeOptOutText } from './opt-out-keywords.util';

describe('opt-out keyword detection', () => {
  it.each([
    'STOP',
    'stop',
    'Stop.',
    'STOP!!!',
    ' stop ',
    'please stop',
    'Stop please',
    'pls stop',
    'unsubscribe',
    'UNSUBSCRIBE',
    'opt out',
    'opt-out',
    'Opt Out',
    'DND',
    'stop messaging me',
    "don't message me",
    'do not contact me',
    'remove me',
    'band karo',
    'message mat karo',
    'Mat bhejo 🙏',
    'mujhe msg mat karo',
  ])('recognises %j as an opt-out', (text) => {
    expect(isOptOutMessage(text)).toBe(true);
  });

  it.each([
    'can we stop by the site on sunday',
    'stop at the second gate',
    'i want to stop paying rent, looking for 2bhk',
    'unsubscribe me from the price alerts but keep the visit',
    'is the bus stop near the project',
    'dnd flat available?',
    'yes',
    'ok',
    '',
    '   ',
    '🙏',
  ])('does not treat %j as an opt-out', (text) => {
    expect(isOptOutMessage(text)).toBe(false);
  });

  it('is null/undefined safe', () => {
    expect(isOptOutMessage(null)).toBe(false);
    expect(isOptOutMessage(undefined)).toBe(false);
  });

  it('normalizes case, punctuation, emoji and whitespace', () => {
    expect(normalizeOptOutText('  STOP!!  🙏 ')).toBe('stop');
    expect(normalizeOptOutText("Don't   message me.")).toBe('dont message me');
  });
});
