import { useReducer, useRef } from 'react';
export type OwnerDraftField = 'git.commit-message';
type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;
const key = (owner: string, field: OwnerDraftField) =>
  `circle.workbench.owner-draft.v1:${encodeURIComponent(owner)}:${field}`;
export function readOwnerDraft(
  storage: DraftStorage,
  owner: string,
  field: OwnerDraftField,
): string {
  const raw = storage.getItem(key(owner, field));
  if (raw === null) return '';
  const record = JSON.parse(raw);
  if (
    record?.version !== 1 ||
    record.owner !== owner ||
    record.field !== field ||
    typeof record.text !== 'string'
  )
    throw Error('invalid owner draft');
  return record.text;
}
export function saveOwnerDraft(
  storage: DraftStorage,
  owner: string,
  field: OwnerDraftField,
  text: string,
): void {
  storage.setItem(
    key(owner, field),
    JSON.stringify({ version: 1, owner, field, text }),
  );
}
/** Persist only user text. A failed write preserves the in-memory input and warns. */
export function useOwnerDraft(
  owner: string,
  field: OwnerDraftField,
): [string, (text: string) => void, boolean] {
  const values = useRef(
    new Map<string, { text: string; unavailable: boolean }>(),
  );
  const active = useRef(owner);
  active.current = owner;
  const [, render] = useReducer((value: number) => value + 1, 0);
  if (!values.current.has(owner)) {
    try {
      values.current.set(owner, {
        text: readOwnerDraft(localStorage, owner, field),
        unavailable: false,
      });
    } catch {
      values.current.set(owner, { text: '', unavailable: true });
    }
  }
  const value = values.current.get(owner)!;
  return [
    value.text,
    (text) => {
      const next = { text, unavailable: false };
      values.current.set(owner, next);
      try {
        saveOwnerDraft(localStorage, owner, field, text);
      } catch {
        next.unavailable = true;
      }
      if (active.current === owner) render();
    },
    value.unavailable,
  ];
}
