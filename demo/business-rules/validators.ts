/**
 * Validates that the provided text is neither empty nor purely whitespace. Throws an Error with a descriptive message if the text is empty, contains only whitespace characters, or is nullish. Used to enforce the text integrity constraint before adding or editing a todo item.
 */
export function validateText(text: string): void {
  if (!text || text.trim().length === 0) {
    throw new Error("Text must not be empty or consist only of whitespace characters.");
  }
}

/**
 * Checks that a todo with the specified id exists in the provided immutable todo array. Returns the found Todo object if it exists, allowing the caller to avoid a redundant lookup. Throws an Error with a descriptive message if no todo with the given id is found, preventing operations on non-existent items.
 */
export function validateTodoExists(id: string, todos: readonly Todo[]): Todo {
  const found = todos.find(todo => todo.id === id);
  if (!found) {
    throw new Error(`Todo with id "${id}" not found.`);
  }
  return found;
}
