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

import fs from 'fs';
import path from 'path';

import { VMExecutor } from '@pkg/backend/backend';
import {
  ContainerDirectoryEntry, ContainerDirectoryListing, ContainerFileKind, ContainerFilePreview, ContainerFileStat,
  ContainerSearchMatch, ContainerSearchResult,
} from '@pkg/backend/containerClient/fileTypes';
import { isRuntimeFsRoot } from '@pkg/backend/containerClient/runtimeFsMount';
import { execCommandWithRetries } from '@pkg/backend/containerClient/snapshotMount';

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_PREVIEW_BYTES = 1_048_576; // 1 MiB
const DEFAULT_MAX_MATCHES = 500;

/**
 * Shell snippet (POSIX/busybox-safe) that stats whatever path is currently
 * named "$name" and prints a single TSV line describing it.  Assumes $name
 * is already set by the caller (either from a directory-listing loop
 * variable, or a one-off assignment for a single-path stat), and that the
 * caller's own mountRoot is available as its third positional parameter
 * ($3), used below to verify a symlink's resolved target is actually
 * reachable by rejoining it with mountRoot -- see buildEntry()'s use of
 * "rejoinok" for why this matters specifically for a runtime-fs root.
 */
const STAT_BODY_SCRIPT = `
if [ -L "$name" ]; then
  islink=1
  target=$(readlink -- "$name" 2>/dev/null)
  resolved=$(readlink -f -- "$name" 2>/dev/null)
  if [ -n "$resolved" ] && { [ -e "$3$resolved" ] || [ -L "$3$resolved" ]; }; then
    rejoinok=1
  else
    rejoinok=0
  fi
else
  islink=0
  target=""
  resolved=""
  rejoinok=0
fi
ftype=$(stat -c %F -- "$name" 2>/dev/null)
size=$(stat -c %s -- "$name" 2>/dev/null)
mtime=$(stat -c %Y -- "$name" 2>/dev/null)
mode=$(stat -c %A -- "$name" 2>/dev/null)
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$islink" "$ftype" "$size" "$mtime" "$mode" "$target" "$resolved" "$rejoinok"
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
  rejoinOk: boolean;
}

function parseStatLine(line: string): RawStatFields | null {
  const fields = line.split('\t');

  if (fields.length < 8) {
    return null;
  }
  const [isLink, fileType, size, mtime, mode, target, resolved, rejoinOk] = fields;

  return {
    isLink: isLink === '1', fileType, size, mtime, mode, target, resolved, rejoinOk: rejoinOk === '1',
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
    // A runtime-fs root (see runtimeFsMount.ts) is a /proc/<pid>/root magic
    // symlink: the kernel resolves paths through it against the *target
    // process's own* mount namespace, so a canonicalized path never comes
    // back prefixed with our mountRoot string -- even for a symlink that's
    // entirely internal to the container. That's not an escape in the usual
    // sense (the kernel structurally can't resolve ".." past that
    // namespace's own root via this mechanism), but it does mean we can't
    // just compare against mountRoot's prefix like the real-mount case
    // below. Instead, STAT_BODY_SCRIPT already checked whether rejoining
    // the resolved path with mountRoot actually exists ("rejoinok") -- most
    // symlinks do (ordinary in-container files); a symlink that bottoms out
    // in procfs's *own* internal magic links (e.g. /etc/mtab -> /proc/mounts
    // -> /proc/self/mounts, which fully canonicalizes to a real VM-global
    // /proc/<pid>/mounts) does not, and is treated the same as an escaping
    // link -- see resolveRegularFileAt()'s matching check and comment.
    symlinkEscapesRoot = isRuntimeFsRoot(mountRoot)
      ? !raw.rejoinOk
      : raw.resolved !== mountRoot && !raw.resolved.startsWith(`${ mountRoot }/`);
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
  const totalRaw = await execCommandWithRetries(vm, { capture: true, root: true }, '/bin/sh', '-c', countScript, '_', absDir);
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
  const raw = await execCommandWithRetries(
    vm, { capture: true, root: true }, '/bin/sh', '-c', listScript, '_', absDir, String(maxEntries), mountRoot,
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
    raw = await execCommandWithRetries(vm, { capture: true, root: true }, '/bin/sh', '-c', script, '_', dir, name, mountRoot);
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

    const runtimeFs = isRuntimeFsRoot(mountRoot);
    const absPath = toAbsolute(mountRoot, filePath);
    let resolvedAbs: string;

    if (runtimeFs) {
      // Canonicalizing a /proc/<pid>/root-rooted *absolute* path directly
      // can fail outright for a relative symlink target (readlink -f loses
      // the path once it crosses the magic-symlink boundary) -- cd into the
      // symlink's own directory first and resolve the bare name instead,
      // matching the pattern STAT_BODY_SCRIPT already uses. Verified
      // empirically against a real dev VM (2026-07-28).
      const dir = path.posix.dirname(absPath);
      const name = path.posix.basename(absPath);

      resolvedAbs = (await execCommandWithRetries(
        vm, { capture: true, root: true }, '/bin/sh', '-c', 'cd "$1" && readlink -f -- "$2"', '_', dir, name,
      )).trim();
    } else {
      resolvedAbs = (await execCommandWithRetries(
        vm, { capture: true, root: true }, '/bin/sh', '-c', 'readlink -f -- "$1"', '_', absPath,
      )).trim();
    }

    if (runtimeFs) {
      // Resolved through the container's own mount namespace: comes back
      // already container-relative (see buildEntry()'s symlinkEscapesRoot
      // comment above), with no mountRoot prefix to strip -- statPathAt()
      // below re-applies mountRoot itself.
      //
      // @note Known, safely-failing limitation (verified against a real dev
      // VM, 2026-07-28): a symlink chain that bottoms out in *procfs's own*
      // internal magic links (e.g. the very common /etc/mtab -> /proc/mounts
      // -> /proc/self/mounts) fully canonicalizes to a real, VM-global path
      // like /proc/<pid>/mounts -- readlink -f can walk all the way through
      // it since /proc is a kernel-global, pid-addressable subsystem, but
      // that path then fails to re-resolve when rejoined with mountRoot
      // (there's no nested /proc/<pid>/root/proc/<pid>/mounts). This throws
      // "not found" rather than previewing successfully. Deliberately not
      // "fixed" by reading the VM-absolute path directly instead: doing so
      // for *any* resolved path would let a crafted symlink to something
      // that only exists on the VM (not inside the container) read host
      // files through the preview/download UI.
      if (!resolvedAbs) {
        throw new Error(`Cannot ${ purpose } ${ filePath }: symlink target is outside the container filesystem`);
      }
      targetPath = resolvedAbs;
    } else {
      if (resolvedAbs !== mountRoot && !resolvedAbs.startsWith(`${ mountRoot }/`)) {
        throw new Error(`Cannot ${ purpose } ${ filePath }: symlink target is outside the container filesystem`);
      }
      targetPath = resolvedAbs.slice(mountRoot.length) || '/';
    }
    targetStat = await statPathAt(vm, mountRoot, targetPath);
  }

  if (targetStat.kind !== 'file') {
    throw new Error(`Cannot ${ purpose } ${ filePath }: not a regular file`);
  }

  return { targetPath, stat: targetStat };
}

/**
 * Read a file's content as base64.
 *
 * For a runtime-fs root (see runtimeFsMount.ts), reads via a retried
 * `execCommand` (root-privileged `base64`) rather than `vm.readFile()`.
 * Two confirmed reasons, both verified against a real dev VM (2026-07-28):
 * `vm.readFile()` is a separate, unretried code path -- on Lima it's a
 * fresh, independent `limaSpawn()` invocation just as exposed to the same
 * intermittent "execCommand returns empty output" flake `execCommandWithRetries`
 * already works around elsewhere in this codebase (see snapshotMount.ts) --
 * and on WSL it goes through the Windows-side `\\wsl$` 9P redirector, a
 * genuinely different and slower-to-settle transport for a freshly-resolved
 * magic-symlink path. Root privilege matters too: reading through
 * `/proc/<pid>/root` requires root, which `execCommand({root: true})`
 * already provides but `vm.readFile()` may not (see downloadFileAt()'s doc
 * comment below for the confirmed case of `vm.copyFileOut()` lacking it
 * entirely). For a real mount, `vm.readFile()` is unchanged -- already
 * proven to work there.
 */
async function readFileContentBase64(vm: VMExecutor, mountRoot: string, absTarget: string): Promise<string> {
  if (isRuntimeFsRoot(mountRoot)) {
    return (await execCommandWithRetries(
      vm, { capture: true, root: true }, '/bin/sh', '-c', 'base64 -- "$1"', '_', absTarget,
    )).trim();
  }

  return (await vm.readFile(absTarget, { encoding: 'base64' })).trim();
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
  const base64 = await readFileContentBase64(vm, mountRoot, absTarget);
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

/**
 * Copy a file out of an already-mounted container rootfs to a host path.
 *
 * For a runtime-fs root, `vm.copyFileOut()` cannot be used at all: on Lima
 * it shells out to `limactl copy`, a plain rsync-over-SSH transfer that runs
 * as the regular SSH user with no root elevation, and reading through
 * `/proc/<pid>/root` requires root. Confirmed empirically against a real dev
 * VM (2026-07-28): `limactl copy` fails outright with "Permission denied"
 * for any procfs-rooted path, every time, not intermittently. Read the
 * content via the VM's own root-privileged shell instead (the same helper
 * `readFilePreviewAt` uses) and write it out here on the host side.
 */
export async function downloadFileAt(vm: VMExecutor, mountRoot: string, filePath: string, hostDestPath: string): Promise<void> {
  const { targetPath } = await resolveRegularFileAt(vm, mountRoot, filePath, 'download');
  const absTarget = toAbsolute(mountRoot, targetPath);

  if (isRuntimeFsRoot(mountRoot)) {
    const base64 = await readFileContentBase64(vm, mountRoot, absTarget);

    await fs.promises.writeFile(hostDestPath, Buffer.from(base64, 'base64'));

    return;
  }

  await vm.copyFileOut(absTarget, hostDestPath);
}

/**
 * Orders two absolute paths the way the tree view displays them: compared
 * segment-by-segment with `localeCompare` (matching ContainerFileTreeNode
 * .vue's own per-directory `sortedEntries()`), so a parent directory always
 * sorts immediately before its own children, and siblings sort the same way
 * they would within any single expanded directory.
 */
function compareTreePaths(a: string, b: string): number {
  const partsA = a.split('/').filter(Boolean);
  const partsB = b.split('/').filter(Boolean);

  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    const cmp = partsA[i].localeCompare(partsB[i]);

    if (cmp !== 0) return cmp;
  }

  return partsA.length - partsB.length;
}

/**
 * Search an already-mounted container rootfs for entries whose basename
 * contains `query` (case-insensitive substring, not a glob/regex).  A single
 * VM round trip, unlike listDirectoryAt()'s count-then-list pattern -- an
 * exact total for a truncated whole-filesystem search would mean walking the
 * entire tree twice, too costly for an operation that's already
 * filesystem-wide. No symlink-escape/rejoin logic here (this only reports
 * what matched, not how to safely read it -- that's handled by
 * resolveRegularFileAt() when a match is later opened), so isRuntimeFsRoot()
 * branching isn't needed for correctness.
 *
 * It *is* needed for performance, though: for a running container (a
 * /proc/<pid>/root runtime-fs root, see runtimeFsMount.ts), the top-level
 * /proc, /sys, and /dev entries are the OCI runtime's own live mounts into
 * the container's namespace -- kernel-virtual trees with thousands of
 * synthetic entries (every process's /proc/<pid>/*, every /sys device node),
 * not real files. A stopped container's snapshot/overlay mount never has
 * these at all (they're added at container start, never part of the image
 * layers), which is why the exact same query runs visibly slower on a
 * running container than a stopped one -- the recursive find is walking all
 * of /proc and /sys too. They're pruned by exact top-level path (not by
 * `-name`, which would also skip an unrelated directory happening to be
 * named "proc"/"sys"/"dev" deeper in the tree) so the browsable tree view
 * (listDirectoryAt(), unaffected by this) still shows and can expand into
 * them -- only the whole-filesystem search skips them. Real bind/volume
 * mounts elsewhere in the tree are untouched and still searched normally.
 */
export async function searchFilesAt(
  vm: VMExecutor,
  mountRoot: string,
  query: string,
  options?: { maxMatches?: number },
): Promise<ContainerSearchResult> {
  const trimmed = query.trim();

  if (!trimmed) {
    return {
      query, matches: [], truncated: false, totalMatchCount: 0,
    };
  }

  const maxMatches = options?.maxMatches ?? DEFAULT_MAX_MATCHES;
  const script = `
cd "$1" || exit 3
lowerQuery=$(printf '%s' "$3" | tr 'A-Z' 'a-z')
find . \\( -path ./proc -o -path ./sys -o -path ./dev \\) -prune -o -mindepth 1 -print 2>/dev/null | while IFS= read -r raw; do
  name="\${raw##*/}"
  lowerName=$(printf '%s' "$name" | tr 'A-Z' 'a-z')
  case "$lowerName" in
    *"$lowerQuery"*)
      if [ -L "$raw" ]; then kind=symlink
      elif [ -d "$raw" ]; then kind=directory
      elif [ -f "$raw" ]; then kind=file
      else kind=other
      fi
      printf '%s\\t%s\\n' "\${raw#./}" "$kind"
      ;;
  esac
done | head -n "$2"
`;
  const raw = await execCommandWithRetries(
    vm, { capture: true, root: true }, '/bin/sh', '-c', script, '_', mountRoot, String(maxMatches + 1), trimmed,
  );

  const lines = raw.split('\n').filter(Boolean);
  const truncated = lines.length > maxMatches;
  const parsed: ContainerSearchMatch[] = lines.map((line) => {
    const [relPath, kind] = line.split('\t');

    return { path: `/${ relPath }`, kind: kind as ContainerFileKind };
  });

  // Sorted before truncating -- `find`'s traversal order is otherwise
  // arbitrary, and stepping through results in tree order (rather than
  // jumping around) is the whole point of returning an ordered list here.
  parsed.sort((a, b) => compareTreePaths(a.path, b.path));
  const matches = truncated ? parsed.slice(0, maxMatches) : parsed;

  return {
    query, matches, truncated, totalMatchCount: truncated ? null : matches.length,
  };
}
