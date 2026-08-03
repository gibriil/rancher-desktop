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

import type { ContainerDiffEntry, ContainerDirectoryEntry } from '@pkg/backend/containerClient/fileTypes';

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

/**
 * `path` is always POSIX-style, absolute from the container root (see
 * ContainerDirectoryEntry.path's own doc comment) -- "relative" here means
 * relative to that root, e.g. `/etc/hosts` -> `etc/hosts`.
 */
export function relativeContainerPath(path: string): string {
  return path.replace(/^\/+/, '');
}

/** A symlink escaping the container's mount is shown but never followed -- this is the feature's security boundary. */
export function isInertEntry(entry: ContainerDirectoryEntry): boolean {
  return entry.kind === 'symlink' && entry.symlinkEscapesRoot;
}

/** Only regular files and (non-inert) symlinks have file content that can actually be downloaded. */
export function isDownloadableEntry(entry: ContainerDirectoryEntry): boolean {
  return !isInertEntry(entry) && (entry.kind === 'file' || entry.kind === 'symlink');
}

/** The preview pane can't be dragged/keyed below this height, in px -- a small file viewer is still usable; a sliver of one isn't. */
export const MIN_PANE_HEIGHT = 120;

/**
 * The file tree's floor is proportional, not a fixed px value like the
 * preview pane's -- a fixed px minimum left very little room for the
 * preview to actually grow into on a typical window size, which was the
 * whole point of this drag handle. 20% of the combined tree+preview space
 * keeps the tree from disappearing while still giving the preview most of
 * the room when dragged to its own extreme.
 */
export const MIN_TREE_HEIGHT_FRACTION = 0.2;

/**
 * Keeps a dragged/keyed pane height within bounds -- `max` is always derived
 * from the *currently measured* space available (see resizedPaneHeight's own
 * doc comment), not a fixed constant, so this stays correct across window
 * sizes rather than baking in one screen size's assumption.
 */
export function clampPaneHeight(height: number, min: number, max: number): number {
  return Math.min(Math.max(height, min), Math.max(min, max));
}

/**
 * The preview pane's new height for a mouse-drag of `deltaY` px from
 * `startHeight` -- dragging the handle down (positive deltaY) shrinks the
 * preview pane (it hands that space to the tree above it), matching the
 * handle sitting at the *top* edge of the preview pane.
 */
export function resizedPaneHeight(startHeight: number, deltaY: number, min: number, max: number): number {
  return clampPaneHeight(startHeight - deltaY, min, max);
}

/** Icon class for a tree row, based on entry kind. */
export function getFileIcon(entry: ContainerDirectoryEntry): string {
  if (entry.kind === 'directory') return 'icon icon-folder';
  if (entry.kind === 'symlink') return 'icon icon-external-link';

  return 'icon icon-file';
}

/** BadgeState color for a `docker diff`/`nerdctl diff` status. */
export function diffBadgeColor(status: ContainerDiffEntry['status']): string {
  switch (status) {
  case 'added': return 'bg-success';
  case 'changed': return 'bg-warning';
  default: return 'bg-darker';
  }
}

/** Human-readable file size, e.g. "1.5 KB"; "?" for an unknown size. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '?';
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));

  return `${ Math.round((bytes / Math.pow(1024, i)) * 100) / 100 } ${ sizes[i] }`;
}

/** Locale-formatted modification time; "?" when unknown. */
export function formatDate(mtime: string | null): string {
  return mtime ? new Date(mtime).toLocaleString() : '?';
}
