import { useRef } from 'react';

/**
 * One function for the life of the component that calls the latest `callback`: what is given
 * it does not render again because the caller made a new closure.
 */
export function useStableCallback<Arguments extends unknown[], Result>(
  callback: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  const latest = useRef(callback);
  latest.current = callback;
  return useRef((...args: Arguments) => latest.current(...args)).current;
}
