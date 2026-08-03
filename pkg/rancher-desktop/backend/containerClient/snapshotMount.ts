/**
 * Shared helper for bind-mounting a containerd snapshot into a temporary
 * directory *inside the VM*, without ever exec-ing into the target
 * container or image.  This is what lets the Files tab work on `scratch`
 * images: the VM's own OS has coreutils and a shell, so once a snapshot is
 * mounted there, browsing it is just VMExecutor.execCommand() against the
 * VM's own binaries.
 *
 * Used by both NerdctlClient (against the bundled k3s containerd) and, when
 * Moby is running in containerd-snapshotter storage mode, MobyClient
 * (against Moby's own containerd) -- the two engines converge on this exact
 * mechanism whenever a real containerd snapshot is available.
 *
 * Originally factored out of NerdctlClient.mountImage(), generalized so the
 * `ctr` socket address and the snapshot key are both parameters: mounting an
 * *image* requires first `nerdctl create`-ing a throwaway container to get a
 * snapshot key, but mounting a *live* container (running or stopped) does
 * not -- the container's own ID is already a valid snapshot key.
 */

import { execOptions, VMExecutor } from '@pkg/backend/backend';

/**
 * Like VMExecutor.execCommand, but retries the command if no output is
 * produced. Works around a rare behavior where execCommand sometimes returns
 * nothing from stdout, as though it did not run at all. See
 * https://github.com/rancher-sandbox/rancher-desktop/issues/4473 for more
 * info.
 */
export async function execCommandWithRetries(vm: VMExecutor, options: execOptions & { capture: true }, ...command: string[]): Promise<string> {
  const maxRetries = 10;
  let result = '';

  for (let i = 0; i < maxRetries && !result; i++) {
    result = await vm.execCommand({ ...options, capture: true }, ...command);
  }

  return result;
}

/**
 * Run a list of cleanup functions in reverse, tolerating individual
 * failures (best-effort; the caller is expected to already be unwinding
 * from some other error, so one cleanup failing must not mask the rest).
 */
export async function runCleanups(cleanups: (() => Promise<unknown>)[]) {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {}
  }
}

export interface MountContainerdSnapshotOptions {
  /** The containerd socket address to use, e.g. "/run/k3s/containerd/containerd.sock". */
  address:     string;
  /** The containerd snapshot key to mount -- for a live container, this is the container ID. */
  snapshotKey: string;
  /** Namespace the snapshot is in, if supported. */
  namespace?:  string;
}

/**
 * Bind-mount the given containerd snapshot into a fresh temporary directory
 * inside the VM.
 * @returns The mount path (inside the VM), plus cleanup functions that must
 * be called in reverse order (e.g. via runCleanups()) once done with it.
 */
export async function mountContainerdSnapshot(
  vm: VMExecutor,
  options: MountContainerdSnapshotOptions,
): Promise<[string, (() => Promise<void>)[]]> {
  const cleanups: (() => Promise<void>)[] = [];
  const namespaceArgs = options.namespace === undefined ? [] : ['--namespace', options.namespace];

  try {
    const workdir = (await execCommandWithRetries(vm, { capture: true }, '/bin/mktemp', '-d', '-t', 'rd-container-files-XXXXXX')).trim();

    cleanups.push(() => vm.execCommand('/bin/rm', '-rf', workdir));

    const command = await execCommandWithRetries(vm, { capture: true, root: true },
      '/usr/bin/ctr', ...namespaceArgs, `--address=${ options.address }`,
      'snapshot', 'mounts', workdir, options.snapshotKey);

    await vm.execCommand({ root: true }, '/bin/sh', '-c', command.trim());
    cleanups.push(async() => {
      try {
        await vm.execCommand({ root: true }, '/bin/umount', workdir);
      } catch (ex) {
        // Unmount might fail due to being busy; just detach and let it go
        // away by itself later.
        await vm.execCommand({ root: true }, '/bin/umount', '-l', workdir);
      }
    });

    return [workdir, cleanups];
  } catch (ex) {
    await runCleanups(cleanups);
    throw ex;
  }
}
