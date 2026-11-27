// One ordering for every list the compiler emits or hashes: plain code-point order.
//
// String.prototype.localeCompare depends on the machine's locale and ICU version, so two machines
// could publish the same criteria in a different order. The default Array.prototype.sort() order is
// deterministic, but it is spelled out here so that every list uses the same, visible rule.

/** Compare two strings by code point (not by locale). For use with Array.prototype.sort. */
export function compareCodePoint(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}
