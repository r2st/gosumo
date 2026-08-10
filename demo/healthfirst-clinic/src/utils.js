// Format an integer rupee amount with Indian digit grouping, e.g. 1499 -> "1,499".
export function formatINR(amount) {
  return new Intl.NumberFormat('en-IN').format(amount)
}
