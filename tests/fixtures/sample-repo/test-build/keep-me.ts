// Folder name "test-build" contains the substring "build" but is NOT
// equal to any default-ignored segment. The loader must include this
// file. Asserts that ignore matching is segment-based, not substring.

export function keepMe(): boolean {
  return true;
}
