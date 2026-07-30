/**
 * Pure, dependency-free helper functions for ContainerFiles.vue -- split out
 * of that component specifically so they're real, independently-testable
 * TypeScript exports rather than named exports from a `.vue` single-file
 * component. The generic ambient `*.vue` module declaration this project's
 * tsconfig relies on only types a component's default export, so a named
 * export from inside a `.vue` file type-checks fine where it's *used*
 * (Vue's own compiler sees the real file), but not where it's *imported by
 * path* for direct unit testing -- moving genuinely pure logic here avoids
 * fighting that rather than working around it.
 */

/**
 * A locally-unique ID to correlate an IPC request with its response -- no
 * cryptographic strength needed, so this deliberately avoids
 * `crypto.randomUUID()`, which isn't reliably present on the `crypto`
 * global across all Electron/Chromium builds this app runs on.
 */
export function generateRequestId(): string {
  return `${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2) }`;
}

/**
 * The directories that must be expanded/loaded to reveal `filePath` in the
 * tree -- every ancestor from the root down to (but not including) the
 * match's own parent-most containing directory.  The match itself is a row
 * rendered by its parent's listing, so it's never loaded/expanded on its own.
 */
export function ancestorPathsOf(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean);

  parts.pop();
  const paths = ['/'];
  let cur = '';

  for (const part of parts) {
    cur += `/${ part }`;
    paths.push(cur);
  }

  return paths;
}

/**
 * Split `name` into segments for highlighting a case-insensitive substring
 * match -- rendered as separate <span>s rather than v-html, since a
 * container's filenames are untrusted-ish data.
 */
export function highlightSegments(name: string, term: string): { text: string, matched: boolean }[] {
  if (!term) {
    return [{ text: name, matched: false }];
  }

  const lower = name.toLowerCase();
  const segments: { text: string, matched: boolean }[] = [];
  let i = 0;
  let idx = lower.indexOf(term, i);

  while (idx !== -1) {
    if (idx > i) {
      segments.push({ text: name.slice(i, idx), matched: false });
    }
    segments.push({ text: name.slice(idx, idx + term.length), matched: true });
    i = idx + term.length;
    idx = lower.indexOf(term, i);
  }
  if (i < name.length) {
    segments.push({ text: name.slice(i), matched: false });
  }

  return segments;
}
