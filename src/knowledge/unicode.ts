// Equivalent to Node 24's String#isWellFormed, without changing Circle's ES2023 type library.
export const wellFormedText = (text: string): boolean =>
  !/[\uD800-\uDFFF]/u.test(text);
