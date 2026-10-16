import { useReducer, useRef, type SetStateAction } from 'react';
/** UI drafts/results belong to the resource owner, including late asynchronous replies. */
export function useOwnerState<T>(
  owner: string,
  initial: T,
): [T, (next: SetStateAction<T>) => void] {
  const values = useRef(new Map<string, T>());
  const active = useRef(owner);
  active.current = owner;
  const [, render] = useReducer((value: number) => value + 1, 0);
  if (!values.current.has(owner)) values.current.set(owner, initial);
  return [
    values.current.get(owner)!,
    (next) => {
      const previous = values.current.get(owner)!;
      values.current.set(
        owner,
        typeof next === 'function' ? (next as (value: T) => T)(previous) : next,
      );
      if (active.current === owner) render();
    },
  ];
}
