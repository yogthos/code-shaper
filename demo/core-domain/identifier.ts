/**
 * Generates and returns a unique string identifier using crypto.randomUUID() for use as a todo item id.
 */
export function generateId(): string {
  return crypto.randomUUID();
}
