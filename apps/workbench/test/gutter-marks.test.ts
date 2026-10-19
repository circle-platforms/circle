import test from 'node:test';
import assert from 'node:assert/strict';
import { gutterMarks } from '../src/model/gutter-marks.ts';

const header = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
`;

test('a line a hunk replaces is changed, a line it only adds is new', () => {
  const diff =
    header +
    `@@ -2,4 +2,5 @@
 keep
-old1
-old2
+new1
+new2
+new3
 tail
`;
  assert.deepEqual(gutterMarks(diff), [
    { kind: 'changed', start: 3, end: 4 },
    { kind: 'added', start: 5, end: 5 },
  ]);
});

test('lines removed and none added mark the line after the gap, and more removed than added leaves changed lines', () => {
  const diff =
    header +
    `@@ -20,3 +21,2 @@
 x
-gone
 y
@@ -40,5 +40,3 @@
 a
-b
-c
-d
+e
 f
`;
  assert.deepEqual(gutterMarks(diff), [
    { kind: 'deleted', start: 22, end: 22 },
    { kind: 'changed', start: 41, end: 41 },
  ]);
});

test('lines added at the start and at the end of a file are marked', () => {
  assert.deepEqual(gutterMarks(`${header}@@ -0,0 +1,2 @@\n+first\n+second\n`), [
    { kind: 'added', start: 1, end: 2 },
  ]);
  assert.deepEqual(gutterMarks(`${header}@@ -3,2 +3,3 @@\n x\n y\n+z\n`), [
    { kind: 'added', start: 5, end: 5 },
  ]);
  // everything removed from the end of a file marks its last line's place
  assert.deepEqual(gutterMarks(`${header}@@ -3,3 +3,1 @@\n x\n-y\n-z\n`), [
    { kind: 'deleted', start: 4, end: 4 },
  ]);
});

test('a file Git calls new is added from its first line to its last', () => {
  const text = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+a
+b
+c
`;
  assert.deepEqual(gutterMarks(text), [{ kind: 'added', start: 1, end: 3 }]);
});

test('text that is not a hunk, a missing newline marker and an empty diff make no marks', () => {
  assert.deepEqual(gutterMarks(''), []);
  assert.deepEqual(
    gutterMarks('Binary files a/x.png and b/x.png differ\n'),
    [],
  );
  assert.deepEqual(gutterMarks(header), []);
  assert.deepEqual(
    gutterMarks(
      `${header}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n`,
    ),
    [{ kind: 'changed', start: 2, end: 2 }],
  );
});

test('each hunk is read from its own start, across files', () => {
  const diff =
    header +
    `@@ -1,1 +1,1 @@
-a
+b
@@ -10,2 +10,3 @@
 c
+d
 e
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,1 @@
-f
+g
`;
  assert.deepEqual(gutterMarks(diff), [
    { kind: 'changed', start: 1, end: 1 },
    { kind: 'added', start: 11, end: 11 },
    { kind: 'changed', start: 5, end: 5 },
  ]);
});
