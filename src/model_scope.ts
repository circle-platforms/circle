export function matchesModel(pattern: string, model: string): boolean {
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else if (character === '[') {
      let end = i + 1;
      if (pattern[end] === '!') end++;
      if (pattern[end] === ']') end++;
      end = pattern.indexOf(']', end);
      if (end < 0) expression += '\\[';
      else {
        let body = pattern.slice(i + 1, end);
        const negate = body.startsWith('!');
        if (negate) body = body.slice(1);
        body = body.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
        if (body.startsWith('^')) body = '\\' + body;
        expression += '[' + (negate ? '^' : '') + body + ']';
        i = end;
      }
    } else expression += character.replace(/[.+^${}()|\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${expression}$`, 'i').test(model);
  } catch {
    return false;
  }
}
/** The same id, ignoring case and a vendor prefix (`zhipu/glm-5.3` is `glm-5.3`). */
export function sameModel(listed: string, current: string): boolean {
  const left = listed.trim().toLowerCase();
  const right = current.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const tail = (value: string): string => value.split('/').at(-1) ?? value;
  return (
    tail(left) === tail(right) ||
    left.endsWith('/' + right) ||
    right.endsWith('/' + left)
  );
}
export function modelScope(
  known: string[],
  patterns: string[],
  current: string,
): string[] {
  const listed = [
    ...new Set(
      current && !known.includes(current) ? [current, ...known] : known,
    ),
  ];
  if (!patterns.length) return listed;
  const scope: string[] = [];
  for (const pattern of patterns) {
    const hits = listed.filter((model) => matchesModel(pattern, model));
    for (const model of hits.length
      ? hits
      : /[*?[]/.test(pattern)
        ? []
        : [pattern])
      if (!scope.includes(model)) scope.push(model);
  }
  return scope;
}
