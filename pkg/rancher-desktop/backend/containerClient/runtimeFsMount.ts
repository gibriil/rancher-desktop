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
 */
export async function resolveRuntimeFsRoot(vm: VMExecutor, pid: number, containerId: string): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const root = `/proc/${ pid }/root`;
  const script = `
test -d "$1" || exit 1
grep -q "$2" "/proc/$3/cgroup" 2>/dev/null || exit 1
echo yes
`;

  try {
    const result = await vm.execCommand(
      { capture: true, root: true, expectFailure: true }, '/bin/sh', '-c', script, '_', root, containerId, String(pid),
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
