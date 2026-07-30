/**
 * Parsers for the (Docker-CLI-compatible) output of `docker/nerdctl diff`
 * and `docker/nerdctl inspect --format '{{json .Mounts}}'`.  Shared between
 * MobyClient and NerdctlClient since nerdctl mirrors Docker's CLI output
 * format for both of these.
 */

import { ContainerDiffEntry, ContainerFileDiffStatus, ContainerMountInfo } from '@pkg/backend/containerClient/fileTypes';

const DIFF_STATUS_BY_LETTER: Record<string, ContainerFileDiffStatus> = {
  A: 'added',
  C: 'changed',
  D: 'deleted',
};

/** Parse `docker diff`/`nerdctl diff` output, e.g. "A /foo\nC /bar\nD /baz". */
export function parseDiffOutput(stdout: string): ContainerDiffEntry[] {
  const entries: ContainerDiffEntry[] = [];

  for (const line of stdout.split('\n')) {
    const match = /^([ACD])\s+(.+)$/.exec(line.trim());

    if (!match) continue;
    const status = DIFF_STATUS_BY_LETTER[match[1]];

    if (status) {
      entries.push({ path: match[2], status });
    }
  }

  return entries;
}

/**
 * Every container gets these bind mounts from the engine itself (resolv.conf/
 * hosts/hostname), regardless of any user-specified `-v`/`--mount`.  They're
 * not meaningful to a user looking for "what did I mount into this
 * container", so they're excluded from the portable mount list.
 */
const IMPLICIT_MOUNT_DESTINATIONS = new Set(['/etc/resolv.conf', '/etc/hosts', '/etc/hostname']);

/** Parse `docker/nerdctl inspect --format '{{json .Mounts}}'` output. */
export function parseMountsOutput(stdout: string): ContainerMountInfo[] {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return [];
  }

  let raw: any[];

  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    // `m` is trusted-external JSON (docker/nerdctl's own inspect output) --
    // guard against a malformed/null entry rather than assuming every
    // element is the object shape we expect.
    .filter(m => typeof m === 'object' && m !== null && !IMPLICIT_MOUNT_DESTINATIONS.has(m.Destination))
    .map(m => ({
      type:        String(m.Type ?? ''),
      source:      String(m.Source ?? ''),
      destination: String(m.Destination ?? ''),
      readWrite:   Boolean(m.RW ?? true),
    }));
}
