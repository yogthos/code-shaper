/**
 * Maintains an in-memory collection of Todo items and provides synchronous mutation operations — add, toggle, edit, remove, and clearCompleted — each independently testable with no I/O side effects.
 */
export class TodoStore {
  /**
   * Appends a newly created active todo with a fresh unique id (generated via crypto.randomUUID()) to the internal todos list and returns the newly created Todo object. Throws an Error if the provided text is empty or contains only whitespace.
   */
  addTodo(text: string): Todo {
    if (!text || !text.trim()) {
      throw new Error("Text cannot be empty or whitespace-only");
    }
    if (!this.todos) {
      this.todos = [];
    }
    const todo = { id: crypto.randomUUID(), text, completed: false };
    this.todos.push(todo);
    return todo;
  }

  /**
   * Flips the completed boolean flag of the todo item identified by the given id in the internal list and returns the updated Todo object. Throws an Error if no todo with the provided id exists in the collection.
   */
  toggleTodo(id: string): Todo {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) {
      throw new Error(`No todo found with id: ${id}`);
    }
    todo.completed = !todo.completed;
    return todo;
  }

  /**
   * Replaces the text content of the todo item identified by the given id with the provided new text string and returns the updated Todo object. Throws an Error if no todo with the provided id exists or if the new text is empty or whitespace-only.
   */
  editTodo(id: string, text: string): Todo {
    if (!text || !text.trim()) {
      throw new Error("Text cannot be empty or whitespace-only");
    }
    const todo = this.todos.find(t => t.id === id);
    if (!todo) {
      throw new Error(`No todo found with id: ${id}`);
    }
    todo.text = text;
    return todo;
  }

  /**
   * Removes the todo item identified by the given id from the internal list. Returns true if a matching todo was found and successfully removed, or false if no todo with the provided id exists in the collection.
   */
  removeTodo(id: string): boolean {
    if (!this.todos) {
      return false;
    }
    const index = this.todos.findIndex(t => t.id === id);
    if (index === -1) {
      return false;
    }
    this.todos.splice(index, 1);
    return true;
  }

  /**
   * Bulk-removes all todo items from the internal list that have their completed flag set to true and returns the count of removed items. Performs no mutation and returns 0 if there are no completed todos.
   */
  clearCompleted(): number {
    if (!this.todos) {
      return 0;
    }
    const completedCount = this.todos.filter(t => t.completed).length;
    if (completedCount === 0) {
      return 0;
    }
    this.todos = this.todos.filter(t => !t.completed);
    return completedCount;
  }
}
