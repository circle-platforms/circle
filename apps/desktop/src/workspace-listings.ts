import type { WorkspaceGrants } from './files.ts';

type Listing = { sessionId: string; workspaceId: string; cursor?: string };

// Each renderer paginates independently: opening a drawer in a pop-out must not
// cancel the main window's discovery or let it consume another window's cursor.
export class WorkspaceListings {
  private owners = new WeakMap<object, Listing>();

  constructor(
    private grants: Pick<WorkspaceGrants, 'open' | 'nextPage' | 'cancel'>,
  ) {}

  async close(from: object): Promise<void> {
    const listing = this.owners.get(from);
    this.owners.delete(from);
    if (listing?.cursor) await this.grants.cancel(listing.cursor);
  }

  async list(
    from: object,
    sessionId: string,
    workspaceId: string,
    path: string,
    cursor: string | undefined,
    assertActive: () => void,
  ) {
    assertActive();
    const previous = this.owners.get(from);
    if (
      cursor &&
      (!previous ||
        previous.sessionId !== sessionId ||
        previous.workspaceId !== workspaceId ||
        previous.cursor !== cursor)
    )
      throw Error('file listing cursor is not owned by this session');
    const selected = cursor
      ? previous!
      : { sessionId, workspaceId, cursor: undefined as string | undefined };
    // Reserve before cancellation yields, so another refresh cannot be overwritten.
    if (!cursor) this.owners.set(from, selected);
    const check = () => {
      assertActive();
      if (this.owners.get(from) !== selected)
        throw Error('file listing was superseded');
    };
    if (!cursor && previous?.cursor) await this.grants.cancel(previous.cursor);
    check();
    const listed = cursor
      ? await this.grants.nextPage(cursor, check)
      : await this.grants.open(path, check);
    try {
      check();
    } catch (error) {
      if (listed.nextCursor) await this.grants.cancel(listed.nextCursor);
      throw error;
    }
    selected.cursor = listed.nextCursor;
    return listed;
  }
}
