/**
 * Filesystem operations run against an already-mounted container rootfs
 * *inside the VM* (see snapshotMount.ts for how that mount is obtained).
 * Every operation here runs via VMExecutor against the VM's own coreutils
 * (busybox on the Alpine-based Lima/WSL guest) -- never against anything
 * inside the target container -- which is what lets this work on `scratch`
 * images with no shell of their own.
 *
 * Shared between NerdctlClient and MobyClient (both storage modes), since
 * once a mount root is available the browsing logic is identical regardless
 * of which engine produced it.
 */

import path from 'path';

import { VMExecutor } from '@pkg/backend/backend';
import {
  ContainerDirectoryEntry, ContainerDirectoryListing, ContainerFileKind, ContainerFilePreview, ContainerFileStat,
} from '@pkg/backend/containerClient/fileTypes';

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_PREVIEW_BYTES = 1_048_576; // 1 MiB

/**
 * Shell snippet (POSIX/busybox-safe) that stats whatever path is currently
 * named "$name" and prints a single TSV line describing it.  Assumes $name
 * is already set by the caller (either from a directory-listing loop
 * variable, or a one-off assignment for a single-path stat).
 */
const STAT_BODY_SCRIPT = `
if [ -L "$name" ]; then
  islink=1
  target=$(readlink -- "$name" 2>/dev/null)
  resolved=$(readlink -f -- "$name" 2>/dev/null)
else
  islink=0
  target=""
  resolved=""
fi
ftype=$(stat -c %F -- "$name" 2>/dev/null)
size=$(stat -c %s -- "$name" 2>/dev/null)
mtime=$(stat -c %Y -- "$name" 2>/dev/null)
mode=$(stat -c %A -- "$name" 2>/dev/null)
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$islink" "$ftype" "$size" "$mtime" "$mode" "$target" "$resolved"
`.trim();

function toAbsolute(mountRoot: string, containerPath: string): string {
  return path.posix.join(mountRoot, containerPath);
}

function mapFileType(fileType: string, isLink: boolean): ContainerFileKind {
  if (isLink) {
    return 'symlink';
  }
  switch (fileType) {
  case 'regular file': case 'regular empty file':
    return 'file';
  case 'directory':
    return 'directory';
  default:
    return 'other';
  }
}

/** Strip the leading file-type character busybox's `stat -c %A` includes. */
function normalizeMode(mode: string): string {
  return /^[-dlpscb]/.test(mode) ? mode.slice(1) : mode;
}

interface RawStatFields {
  isLink:   boolean;
  fileType: string;
  size:     string;
  mtime:    string;
  mode:     string;
  target:   string;
  resolved: string;
}

function parseStatLine(line: string): RawStatFields | null {
  const fields = line.split('\t');

  if (fields.length < 7) {
    return null;
  }
  const [isLink, fileType, size, mtime, mode, target, resolved] = fields;

  return {
    isLink: isLink === '1', fileType, size, mtime, mode, target, resolved,
  };
}

function buildEntry(name: string, containerPath: string, mountRoot: string, raw: RawStatFields | null): ContainerDirectoryEntry {
  if (!raw || (!raw.fileType && !raw.isLink)) {
    return {
      name,
      path:               containerPath,
      kind:               'other',
      size:               null,
      mode:               '',
      mtime:              null,
      symlinkTarget:      null,
      symlinkEscapesRoot: false,
      permissionDenied:   true,
    };
  }

  const kind = mapFileType(raw.fileType, raw.isLink);
  let symlinkEscapesRoot = false;

  if (raw.isLink && raw.resolved) {
    symlinkEscapesRoot = raw.resolved !== mountRoot && !raw.resolved.startsWith(`${ mountRoot }/`);
  }

  return {
    name,
    path:               containerPath,
    kind,
    size:               raw.size ? Number(raw.size) : null,
    mode:               raw.mode ? normalizeMode(raw.mode) : '',
    mtime:              raw.mtime ? new Date(Number(raw.mtime) * 1000).toISOString() : null,
    symlinkTarget:      raw.isLink ? (raw.target || null) : null,
    symlinkEscapesRoot,
    permissionDenied:   raw.isLink ? false : !raw.fileType,
  };
}

/**
 * List the immediate children of a directory inside an already-mounted
 * container rootfs.
 */
export async function listDirectoryAt(
  vm: VMExecutor,
  mountRoot: string,
  dirPath: string,
  options?: { maxEntries?: number },
): Promise<ContainerDirectoryListing> {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const absDir = toAbsolute(mountRoot, dirPath);

  const countScript = 'cd "$1" || exit 3; find . -mindepth 1 -maxdepth 1 | wc -l';
  const totalRaw = await vm.execCommand({ capture: true, root: true }, '/bin/sh', '-c', countScript, '_', absDir);
  const totalEntryCount = Number(totalRaw.trim()) || 0;

  if (totalEntryCount === 0) {
    return {
      path: dirPath, entries: [], truncated: false, totalEntryCount: 0,
    };
  }

  const listScript = `
cd "$1" || exit 3
find . -mindepth 1 -maxdepth 1 | head -n "$2" | while IFS= read -r raw; do
  name="\${raw#./}"
  ${ STAT_BODY_SCRIPT.split('\n').join('\n  ') }
  printf 'NAME\\t%s\\n' "$name"
done
`;
  const raw = await vm.execCommand(
    { capture: true, root: true }, '/bin/sh', '-c', listScript, '_', absDir, String(maxEntries),
  );

  const entries: ContainerDirectoryEntry[] = [];
  let pendingStat: RawStatFields | null = null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.startsWith('NAME\t')) {
      const name = line.slice('NAME\t'.length);
      const childPath = path.posix.join(dirPath, name);

      entries.push(buildEntry(name, childPath, mountRoot, pendingStat));
      pendingStat = null;
    } else {
      pendingStat = parseStatLine(line);
    }
  }

  return {
    path:      dirPath,
    entries,
    truncated: totalEntryCount > maxEntries,
    totalEntryCount,
  };
}

/** Stat a single path inside an already-mounted container rootfs. */
export async function statPathAt(vm: VMExecutor, mountRoot: string, filePath: string): Promise<ContainerFileStat> {
  const absPath = toAbsolute(mountRoot, filePath);
  const dir = path.posix.dirname(absPath);
  const name = path.posix.basename(absPath);
  const script = `
cd "$1" || exit 3
name="$2"
[ -e "$name" ] || [ -L "$name" ] || exit 4
${ STAT_BODY_SCRIPT }
`;

  let raw: string;

  try {
    raw = await vm.execCommand({ capture: true, root: true }, '/bin/sh', '-c', script, '_', dir, name);
  } catch (ex) {
    throw new Error(`Path not found: ${ filePath }`, { cause: ex });
  }

  const parsed = parseStatLine(raw.trim());

  if (!parsed) {
    throw new Error(`Path not found: ${ filePath }`);
  }
  const { name: _name, ...stat } = buildEntry(name, filePath, mountRoot, parsed);

  return stat;
}

/**
 * Resolve `filePath` to a regular file, following a symlink if `filePath`
 * itself is one.  Throws if the symlink escapes the mount, or if the
 * resolved path isn't a regular file.
 */
export async function resolveRegularFileAt(
  vm: VMExecutor, mountRoot: string, filePath: string, purpose: string,
): Promise<{ targetPath: string, stat: ContainerFileStat }> {
  const stat = await statPathAt(vm, mountRoot, filePath);
  let targetStat = stat;
  let targetPath = filePath;

  if (stat.kind === 'symlink') {
    if (stat.symlinkEscapesRoot || !stat.symlinkTarget) {
      throw new Error(`Cannot ${ purpose } ${ filePath }: symlink target is outside the container filesystem`);
    }

    const absPath = toAbsolute(mountRoot, filePath);
    const resolvedAbs = (await vm.execCommand(
      { capture: true, root: true }, '/bin/sh', '-c', 'readlink -f -- "$1"', '_', absPath,
    )).trim();

    if (resolvedAbs !== mountRoot && !resolvedAbs.startsWith(`${ mountRoot }/`)) {
      throw new Error(`Cannot ${ purpose } ${ filePath }: symlink target is outside the container filesystem`);
    }
    targetPath = resolvedAbs.slice(mountRoot.length) || '/';
    targetStat = await statPathAt(vm, mountRoot, targetPath);
  }

  if (targetStat.kind !== 'file') {
    throw new Error(`Cannot ${ purpose } ${ filePath }: not a regular file`);
  }

  return { targetPath, stat: targetStat };
}

/**
 * Read a size- and type-capped preview of a file's contents.  Symlinks are
 * transparently followed as long as they resolve inside the mount; a
 * symlink escaping the mount is refused rather than followed, since the
 * mount is a real filesystem path inside the VM.
 */
export async function readFilePreviewAt(
  vm: VMExecutor,
  mountRoot: string,
  filePath: string,
  options?: { maxBytes?: number },
): Promise<ContainerFilePreview> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
  const { targetPath, stat: targetStat } = await resolveRegularFileAt(vm, mountRoot, filePath, 'preview');
  const totalSize = targetStat.size ?? 0;

  if (totalSize > maxBytes) {
    return {
      path: filePath, kind: 'too-large', encoding: null, content: null, truncated: true, totalSize, mimeGuess: null,
    };
  }

  const absTarget = toAbsolute(mountRoot, targetPath);
  const base64 = (await vm.readFile(absTarget, { encoding: 'base64' })).trim();
  const buf = Buffer.from(base64, 'base64');
  const isBinary = buf.includes(0);

  if (isBinary) {
    return {
      path: filePath, kind: 'binary', encoding: 'base64', content: base64, truncated: false, totalSize, mimeGuess: null,
    };
  }

  return {
    path: filePath, kind: 'text', encoding: 'utf-8', content: buf.toString('utf-8'), truncated: false, totalSize, mimeGuess: null,
  };
}

/** Copy a file out of an already-mounted container rootfs to a host path. */
export async function downloadFileAt(vm: VMExecutor, mountRoot: string, filePath: string, hostDestPath: string): Promise<void> {
  const { targetPath } = await resolveRegularFileAt(vm, mountRoot, filePath, 'download');

  await vm.copyFileOut(toAbsolute(mountRoot, targetPath), hostDestPath);
}
