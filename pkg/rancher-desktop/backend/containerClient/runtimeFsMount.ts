/**
 * Access to a *running* container's live runtime filesystem view, as an
 * alternative to the static snapshot/overlay mounts in snapshotMount.ts.
 *
 * A containerd snapshot (or an overlay2 graph-driver mount) only ever
 * reflects a container's image layers plus its writable layer -- it has no
 * knowledge of what the OCI runtime (runc, via containerd-shim) additionally
 * mounts into the container's own mount namespace when starting its init
 * process: /proc, /sys, /dev, /dev/shm, cgroup mounts, and any bind/volume
 * mounts. Those are all instances of the same gap, not separate special
 * cases -- so this module is named around that general intent ("the live
 * runtime filesystem"), not around the one mechanism used to reach it.
 *
 * The mechanism: /proc/<pid>/root is a magic symlink that, when resolved
 * from the VM's own procfs, transparently walks through that process's own
 * mount namespace. Reading through it is a plain filesystem operation from
 * the VM's perspective -- no exec into the container is involved, which is
 * what keeps this compatible with `scratch` images that have no shell.
 */

import { VMExecutor } from '@pkg/backend/backend';
import { execCommandWithRetries, runCleanups } from '@pkg/backend/containerClient/snapshotMount';

/**
 * Confirm that `/proc/<pid>/root` is usable as a live view of `containerId`'s
 * filesystem, and return it if so.
 *
 * Two checks are made: that the magic-root symlink is actually traversable
 * (the process may have exited, or never existed), and that the process at
 * `pid` still belongs to `containerId` (a cheap mitigation for PID reuse:
 * both containerd and dockerd include the container ID in the cgroup path,
 * e.g. `cri-containerd-<id>.scope` or `docker-<id>.scope`).
 *
 * Never throws; returns null for any failure so callers can uniformly treat
 * "not usable right now" as "fall back to the snapshot/overlay mount".
 *
 * Uses execCommandWithRetries() -- but note the script below always prints
 * "yes" or "no" rather than relying on a bare non-zero exit for the "no"
 * case (unlike similar scripts elsewhere in this codebase): that retry
 * helper's "empty output means the command flaked, try again" heuristic
 * would otherwise misfire on the perfectly legitimate, silent "no" a
 * stopped container produces every time -- burning up to 10 retries on
 * what is by far the single most common result of this check, rather than
 * only retrying on a genuine flake.
 */
export async function resolveRuntimeFsRoot(vm: VMExecutor, pid: number, containerId: string): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const root = `/proc/${ pid }/root`;
  const script = `
if [ -d "$1" ] && grep -qF "$2" "/proc/$3/cgroup" 2>/dev/null; then
  echo yes
else
  echo no
fi
`;

  try {
    const result = await execCommandWithRetries(
      vm, { capture: true, root: true }, '/bin/sh', '-c', script, '_', root, containerId, String(pid),
    );

    return result.trim() === 'yes' ? root : null;
  } catch {
    return null;
  }
}

/**
 * True if `mountRoot` was produced by resolveRuntimeFsRoot() rather than a
 * real snapshot/overlay mount. Real mounts always live under a
 * mktemp-generated `/tmp/rd-container-files-XXXXXX`-style path, so this
 * can't collide.
 */
export function isRuntimeFsRoot(mountRoot: string): boolean {
  return /^\/proc\/\d+\/root$/.test(mountRoot);
}

/**
 * Parse the `Running`/`Pid` fields out of a `container inspect --format
 * '{{json .State}}'` result, defaulting to "not running" on any unexpected
 * shape so callers fall back to the snapshot/overlay mount rather than
 * throwing.
 *
 * Shared between NerdctlClient and MobyClient -- both parse the exact same
 * `docker`/`nerdctl container inspect --format '{{json .State}}'` shape.
 */
export function parseContainerState(stdout: string): { running: boolean, pid: number } {
  try {
    const state = JSON.parse(stdout.trim());

    return { running: state?.Running === true, pid: Number(state?.Pid) || 0 };
  } catch {
    return { running: false, pid: 0 };
  }
}

/**
 * If mountRoot is a live runtime-fs root (see resolveRuntimeFsRoot() above)
 * and ex indicates the underlying operation failed, remap it to a clear
 * message about the container having stopped or restarted mid-browse,
 * rather than whatever raw failure a vanished /proc/<pid>/root produces.
 *
 * Shared between NerdctlClient and MobyClient -- both need the identical
 * remapping regardless of which mount mechanism produced mountRoot.
 */
export function remapRuntimeFsError(mountRoot: string, containerId: string, ex: unknown): unknown {
  if (isRuntimeFsRoot(mountRoot)) {
    // Include the real cause inline rather than only attaching it via
    // `.cause` (which never reaches the renderer -- see main/containerFiles.ts's
    // errorMessage()). A container that's genuinely stopped/restarted
    // mid-browse is one real cause, but not the only one; surfacing the
    // actual message keeps this honest if it's something else entirely.
    const reason = ex instanceof Error ? ex.message : String(ex);

    return new Error(
      `Container ${ containerId } appears to have stopped or restarted while browsing, or the request failed transiently (${ reason }); refresh and try again.`,
      { cause: ex },
    );
  }

  return ex;
}

/**
 * Mount → run one file-browsing operation → remap a runtime-fs error →
 * clean up, in that order -- the shape every one of NerdctlClient's and
 * MobyClient's five file-browsing methods needs identically, previously
 * duplicated ten times (five methods × two clients) rather than shared.
 *
 * `mountContainer` is passed in rather than called directly because it's
 * engine-specific (each client's own mount-selection logic); everything
 * after the mount (the try/remap/cleanup shape) is not.
 */
export async function withMount<T>(
  mountContainer: (containerId: string, namespace?: string) => Promise<[string, (() => Promise<void>)[]]>,
  containerId: string,
  namespace: string | undefined,
  op: (mountRoot: string) => Promise<T>,
): Promise<T> {
  const [mountRoot, cleanups] = await mountContainer(containerId, namespace);

  try {
    return await op(mountRoot);
  } catch (ex) {
    throw remapRuntimeFsError(mountRoot, containerId, ex);
  } finally {
    await runCleanups(cleanups);
  }
}
