/** Presentation state only: completed plans remain in the runtime and stored history. */
export function planComplete(todos: readonly { status: string }[]): boolean {
  return todos.length > 0 && todos.every((todo) => todo.status === 'completed');
}

export function planVisible(
  todos: readonly { status: string }[],
  keepCompleted = false,
): boolean {
  return todos.length > 0 && (keepCompleted || !planComplete(todos));
}

/** Seed from restored state; report completion once per incomplete-to-complete transition. */
export class PlanCompletionTracker {
  private completed = false;
  reset(todos: readonly { status: string }[]): void {
    this.completed = planComplete(todos);
  }
  update(todos: readonly { status: string }[]): number | undefined {
    const completed = planComplete(todos);
    const count = completed && !this.completed ? todos.length : undefined;
    this.completed = completed;
    return count;
  }
}
