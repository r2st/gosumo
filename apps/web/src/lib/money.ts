/**
 * Form-side money helpers. The API stores money in paise (integers); inputs
 * collect rupees. These convert between the two without going through the
 * display formatter in ./format (which produces a currency-styled string).
 */

/** Parse a rupees string/number from an input into integer paise. Returns 0 for blanks. */
export function rupeesToPaise(rupees: string | number | null | undefined): number {
  if (rupees === '' || rupees === null || rupees === undefined) return 0;
  const value = typeof rupees === 'number' ? rupees : parseFloat(rupees);
  if (Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

/** Convert paise into a plain rupees number suitable for a number input value. */
export function paiseToRupeesInput(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  return (paise / 100).toString();
}
