/** Sum of a list of numbers. */
export function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/** Arithmetic mean. */
export function mean(values) {
  return sum(values) / values.length;
}
