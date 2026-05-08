/**
 * Maintains an in-memory collection of todo items and exposes query methods to retrieve filtered, immutable snapshots of the current store state without side effects.
 */
export class TodoStore {
  /**
   * Returns a frozen, read-only snapshot array containing every todo item currently in the store. The returned array is a shallow-frozen copy produced via Object.freeze, ensuring callers cannot mutate the internal state. Reflects the state of the store at the exact moment of invocation with no side effects.
   */
  getAll(): readonly Todo[] {
    throw new Error("getAll: not implemented");
  }

  /**
   * Returns a frozen, read-only snapshot array containing only the todo items whose completed flag is false. Filters the internal list, freezes the resulting array, and returns it. The returned array must not reflect subsequent mutations to the store. Testable by adding a mix of active and completed todos, calling getActive, then verifying only items with completed === false are present and the array is frozen.
   */
  getActive(): readonly Todo[] {
    throw new Error("getActive: not implemented");
  }

  /**
   * Returns a frozen, read-only snapshot array containing only the todo items whose completed flag is true. Filters the internal list, freezes the resulting array, and returns it. The returned array must not reflect subsequent mutations to the store. Testable by completing some todos, calling getCompleted, then verifying only items with completed === true are present and the array is frozen.
   */
  getCompleted(): readonly Todo[] {
    throw new Error("getCompleted: not implemented");
  }
}
