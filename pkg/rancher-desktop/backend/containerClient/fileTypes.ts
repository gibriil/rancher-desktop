/**
 * Data contracts for browsing a container's filesystem (the Files tab).
 *
 * These types are intentionally plain, JSON-round-trip-safe interfaces (no
 * `Buffer`, `Date`, `Map`/`Set`, or class instances; `null` instead of
 * `undefined`) so the same shapes can later be reused by a non-Electron
 * consumer (e.g. a rancher/dashboard port) that would move them over HTTP
 * instead of Electron IPC.
 */

/** The kind of filesystem entry.  'other' covers sockets/FIFOs/devices. */
export type ContainerFileKind = 'file' | 'directory' | 'symlink' | 'other';

/** Whether a path was added, changed, or deleted relative to the image. */
export type ContainerFileDiffStatus = 'added' | 'changed' | 'deleted';

/**
 * A mount (bind or volume) affecting a container, in a portable shape
 * (lower-camel-case, engine-agnostic) rather than Docker's wire format.
 */
export interface ContainerMountInfo {
  type:        string;
  source:      string;
  destination: string;
  readWrite:   boolean;
}

/**
 * A single entry within a directory listing.
 * @note `path` is always POSIX-style, absolute from the container root
 * (e.g. `/etc/hosts`) -- never a host or VM path.
 * @note This does not carry "modified"/"mounted" annotations -- those are
 * container-wide (not per-directory), so callers fetch getContainerDiff()/
 * getContainerMounts() once and cross-reference by `path` themselves rather
 * than paying for a diff/mounts lookup on every directory listing.
 */
export interface ContainerDirectoryEntry {
  name:               string;
  path:               string;
  kind:               ContainerFileKind;
  /** Size in bytes, or null when unavailable (e.g. permission denied). */
  size:               number | null;
  /** POSIX permission string, e.g. "rwxr-xr-x". */
  mode:               string;
  /** ISO-8601 timestamp, or null when unavailable. */
  mtime:              string | null;
  /** Resolved symlink target, only set when kind === 'symlink'. */
  symlinkTarget:      string | null;
  /** Set when the symlink target resolves outside the container's mount. */
  symlinkEscapesRoot: boolean;
  permissionDenied:   boolean;
}

/** The result of listing a single directory. */
export interface ContainerDirectoryListing {
  path:            string;
  entries:         ContainerDirectoryEntry[];
  /** True when entries were capped; see totalEntryCount for the real count. */
  truncated:       boolean;
  totalEntryCount: number | null;
}

/** Stat information for a single path (no `name`, unlike a directory entry). */
export type ContainerFileStat = Omit<ContainerDirectoryEntry, 'name'>;

/** How a file's contents should be presented in a preview pane. */
export type ContainerFilePreviewKind = 'text' | 'binary' | 'too-large';

/** A size- and type-capped preview of a file's contents. */
export interface ContainerFilePreview {
  path:      string;
  kind:      ContainerFilePreviewKind;
  /** Only set when kind !== 'too-large'. */
  encoding:  'utf-8' | 'base64' | null;
  /** Only set when kind !== 'too-large'. */
  content:   string | null;
  /** True when content was cut off before the end of the file. */
  truncated: boolean;
  totalSize: number;
  /** Best-effort MIME type guess, or null if unknown. */
  mimeGuess: string | null;
}

/** A single changed path, as reported by `docker diff` / `nerdctl diff`. */
export interface ContainerDiffEntry {
  path:   string;
  status: ContainerFileDiffStatus;
}

/**
 * Whether browsing this container's filesystem is currently possible, and
 * why not if it isn't.  Lets a container report "not available" as a
 * first-class state instead of every call failing with a generic error.
 */
export interface ContainerFilesCapabilities {
  supported: boolean;
  reason:    string | null;
}

/**
 * A single full-filesystem search hit.  Deliberately lighter than
 * ContainerDirectoryEntry -- no stat/symlink data -- since revealing a match
 * in the tree re-fetches its containing directory via listContainerDirectory()
 * anyway, which already produces a full entry for it.
 */
export interface ContainerSearchMatch {
  path: string;
  kind: ContainerFileKind;
}

/** The result of a whole-filesystem search. */
export interface ContainerSearchResult {
  query:           string;
  matches:         ContainerSearchMatch[];
  /** True when matches were capped; see totalMatchCount for the real count. */
  truncated:       boolean;
  /**
   * Exact count when not truncated; null when truncated -- getting an exact
   * total would mean walking the whole filesystem twice, not worth doubling
   * the cost of an already filesystem-wide operation.
   */
  totalMatchCount: number | null;
}
