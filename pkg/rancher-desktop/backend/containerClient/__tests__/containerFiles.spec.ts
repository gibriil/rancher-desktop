/** @jest-environment node */

import { jest } from '@jest/globals';

import type { VMExecutor } from '@pkg/backend/backend';
import {
  listDirectoryAt, resolveRegularFileAt, searchFilesAt, statPathAt,
} from '@pkg/backend/containerClient/containerFsOps';
import { parseDiffOutput, parseMountsOutput } from '@pkg/backend/containerClient/dockerFormatParsers';
import { isRuntimeFsRoot } from '@pkg/backend/containerClient/runtimeFsMount';

describe('parseDiffOutput', () => {
  it('parses added/changed/deleted entries', () => {
    const stdout = 'A /new-file\nC /changed-file\nD /removed-file\n\n';

    expect(parseDiffOutput(stdout)).toEqual([
      { path: '/new-file', status: 'added' },
      { path: '/changed-file', status: 'changed' },
      { path: '/removed-file', status: 'deleted' },
    ]);
  });

  it('ignores unparseable lines', () => {
    expect(parseDiffOutput('not a diff line\n')).toEqual([]);
  });
});

describe('parseMountsOutput', () => {
  it('maps Docker-format mounts to the portable shape', () => {
    const stdout = JSON.stringify([
      { Type: 'bind', Source: '/host/path', Destination: '/data', RW: true },
      { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data', Destination: '/vol', RW: false },
    ]);

    expect(parseMountsOutput(stdout)).toEqual([
      { type: 'bind', source: '/host/path', destination: '/data', readWrite: true },
      { type: 'volume', source: '/var/lib/docker/volumes/x/_data', destination: '/vol', readWrite: false },
    ]);
  });

  it('filters out the implicit resolv.conf/hosts/hostname mounts every container gets', () => {
    const stdout = JSON.stringify([
      { Type: 'bind', Source: '/var/lib/nerdctl/x/resolv.conf', Destination: '/etc/resolv.conf', RW: true },
      { Type: 'bind', Source: '/var/lib/nerdctl/x/hosts', Destination: '/etc/hosts', RW: true },
      { Type: 'bind', Source: '/var/lib/nerdctl/x/hostname', Destination: '/etc/hostname', RW: true },
      { Type: 'bind', Source: '/host/data', Destination: '/data', RW: true },
    ]);

    expect(parseMountsOutput(stdout)).toEqual([
      { type: 'bind', source: '/host/data', destination: '/data', readWrite: true },
    ]);
  });

  it('returns an empty array for empty or invalid input', () => {
    expect(parseMountsOutput('')).toEqual([]);
    expect(parseMountsOutput('not json')).toEqual([]);
    expect(parseMountsOutput('{}')).toEqual([]);
  });
});

/** Build a mocked VMExecutor whose execCommand dispatches on the shell script text. */
function mockVM(responses: { countScript: string, listScript: string }): VMExecutor {
  return {
    backend:     'lima',
    execCommand: jest.fn((...args: any[]) => {
      const command = typeof args[0] === 'object' ? args.slice(1) : args;
      const script = command[2] as string;

      return Promise.resolve(script.includes('wc -l') ? responses.countScript : responses.listScript);
    }),
  } as unknown as VMExecutor;
}

const MOUNT_ROOT = '/tmp/rd-container-files-test';

describe('listDirectoryAt', () => {
  it('parses entries and flags symlinks that escape the mount', async() => {
    const listScript = [
      '0\tregular file\t42\t1700000000\t-rw-r--r--\t\t\t0',
      'NAME\tregular.txt',
      '1\tsymbolic link\t\t\tlrwxrwxrwx\t/etc/shadow\t/etc/shadow\t0',
      'NAME\tevil-link',
      `1\tsymbolic link\t\t\tlrwxrwxrwx\tconf.txt\t${ MOUNT_ROOT }/conf.txt\t1`,
      'NAME\tsafe-link',
    ].join('\n');

    const vm = mockVM({ countScript: '3\n', listScript });
    const result = await listDirectoryAt(vm, MOUNT_ROOT, '/');

    expect(result.totalEntryCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(3);

    const [regular, evilLink, safeLink] = result.entries;

    expect(regular).toMatchObject({
      name: 'regular.txt', path: '/regular.txt', kind: 'file', size: 42, mode: 'rw-r--r--',
    });

    expect(evilLink).toMatchObject({
      name: 'evil-link', kind: 'symlink', symlinkTarget: '/etc/shadow', symlinkEscapesRoot: true,
    });

    expect(safeLink).toMatchObject({
      name: 'safe-link', kind: 'symlink', symlinkTarget: 'conf.txt', symlinkEscapesRoot: false,
    });
  });

  it('returns an empty listing without a second round trip when the directory has no entries', async() => {
    const vm = mockVM({ countScript: '0\n', listScript: 'should not be used' });
    const result = await listDirectoryAt(vm, MOUNT_ROOT, '/empty');

    expect(result).toEqual({
      path: '/empty', entries: [], truncated: false, totalEntryCount: 0,
    });
    expect((vm.execCommand as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('reports truncation when there are more entries than the cap', async() => {
    const listScript = [
      '0\tregular file\t1\t1700000000\t-rw-r--r--\t\t\t0',
      'NAME\tonly-entry-returned',
    ].join('\n');
    const vm = mockVM({ countScript: '5000\n', listScript });
    const result = await listDirectoryAt(vm, MOUNT_ROOT, '/', { maxEntries: 1 });

    expect(result.totalEntryCount).toBe(5000);
    expect(result.truncated).toBe(true);
  });
});

describe('listDirectoryAt against a runtime-fs (procfs) root', () => {
  const RUNTIME_ROOT = '/proc/4242/root';

  it('flags a symlink as escaping when its resolved target does not exist when rejoined with mountRoot', async() => {
    // Simulates /etc/mtab -> /proc/mounts -> /proc/4242/mounts: readlink -f
    // fully resolves it (since /proc is kernel-global), but that path
    // doesn't exist as /proc/4242/root/proc/4242/mounts, so rejoinok is 0.
    const listScript = [
      '1\tsymbolic link\t\t\tlrwxrwxrwx\t/proc/mounts\t/proc/4242/mounts\t0',
      'NAME\tmtab',
    ].join('\n');

    const vm = mockVM({ countScript: '1\n', listScript });
    const result = await listDirectoryAt(vm, RUNTIME_ROOT, '/etc');

    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'mtab', kind: 'symlink', symlinkEscapesRoot: true }),
    ]);
  });

  it('does not flag an ordinary in-container symlink whose resolved target rejoins with mountRoot', async() => {
    // Simulates /etc/os-release -> ../usr/lib/os-release: readlink -f
    // resolves it to the bare container-relative /usr/lib/os-release, which
    // *does* exist when rejoined as /proc/4242/root/usr/lib/os-release.
    const listScript = [
      '1\tsymbolic link\t\t\tlrwxrwxrwx\t../usr/lib/os-release\t/usr/lib/os-release\t1',
      'NAME\tos-release',
    ].join('\n');

    const vm = mockVM({ countScript: '1\n', listScript });
    const result = await listDirectoryAt(vm, RUNTIME_ROOT, '/etc');

    expect(result.entries).toEqual([
      expect.objectContaining({ name: 'os-release', kind: 'symlink', symlinkEscapesRoot: false }),
    ]);
  });
});

describe('statPathAt', () => {
  it('throws a clear error when the path does not exist', async() => {
    const vm = {
      backend:     'lima',
      execCommand: jest.fn(() => Promise.reject(new Error('exit status 4'))),
    } as unknown as VMExecutor;

    await expect(statPathAt(vm, MOUNT_ROOT, '/missing')).rejects.toThrow('Path not found: /missing');
  });
});

describe('isRuntimeFsRoot', () => {
  it('recognizes a /proc/<pid>/root magic-root path', () => {
    expect(isRuntimeFsRoot('/proc/4242/root')).toBe(true);
    expect(isRuntimeFsRoot('/proc/1/root')).toBe(true);
  });

  it('does not mistake a real mktemp-style mount root, or a lookalike path, for a runtime-fs root', () => {
    expect(isRuntimeFsRoot('/tmp/rd-container-files-XXXXXX')).toBe(false);
    // Must anchor at both ends -- a path merely containing the pattern isn't enough.
    expect(isRuntimeFsRoot('/proc/4242/root/etc')).toBe(false);
    expect(isRuntimeFsRoot('/mnt/proc/4242/root')).toBe(false);
    expect(isRuntimeFsRoot('/proc/not-a-pid/root')).toBe(false);
  });
});

// This is the function that actually *enforces* the "a symlink escaping the
// container filesystem is never followed" security boundary -- previously,
// only buildEntry()'s *labeling* of an escaping symlink (via listDirectoryAt,
// above) had test coverage, not the code path that actually blocks a
// preview/download from following one. See known-bugs.md #7-adjacent
// reasoning in the style guide this branch was reviewed against: security-
// adjacent logic doesn't ship without a test.
describe('resolveRegularFileAt', () => {
  /**
   * Distinguishes call shapes by inspecting the actual positional args
   * rather than call order: the stat script (shared by both the initial-file
   * stat and the resolved-target's stat, keyed here by which basename ($2)
   * it's stat-ing) versus the standalone `readlink -f` call this function
   * makes itself, independent of whatever the initial stat already computed.
   */
  function mockResolveVM(config: { statByName: Record<string, string>, readlinkResult: string }): VMExecutor {
    return {
      backend:     'lima',
      execCommand: jest.fn((...args: any[]) => {
        const command = typeof args[0] === 'object' ? args.slice(1) : args;
        const script = command[2] as string;

        if (script.includes('readlink -f -- "$1"')) {
          return Promise.resolve(config.readlinkResult);
        }
        const name = command[5] as string;

        return Promise.resolve(config.statByName[name] ?? '');
      }),
    } as unknown as VMExecutor;
  }

  it('blocks a symlink already flagged as escaping the mount by its initial stat, without following it further', async() => {
    const vm = mockResolveVM({
      statByName:     { 'evil-link': ['1', 'symbolic link', '', '', 'lrwxrwxrwx', '/etc/shadow', '/etc/shadow', '0'].join('\t') },
      readlinkResult: 'should not be reached',
    });

    await expect(resolveRegularFileAt(vm, MOUNT_ROOT, '/evil-link', 'preview'))
      .rejects.toThrow('symlink target is outside the container filesystem');
    // Only the initial stat call should happen -- must reject before ever
    // issuing its own readlink -f.
    expect((vm.execCommand as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it("independently rejects a symlink whose live-resolved target escapes the mount, even when the initial stat didn't flag it", async() => {
    // Deliberately inconsistent with what a real stat script would ever
    // return together, to prove this function's own readlink -f check is a
    // genuine, separate verification -- not just trusting buildEntry's
    // already-computed flag from the first stat call.
    const vm = mockResolveVM({
      statByName:     { 'sneaky-link': ['1', 'symbolic link', '', '', 'lrwxrwxrwx', 'elsewhere', `${ MOUNT_ROOT }/elsewhere`, '1'].join('\t') },
      readlinkResult: '/etc/shadow',
    });

    await expect(resolveRegularFileAt(vm, MOUNT_ROOT, '/sneaky-link', 'preview'))
      .rejects.toThrow('symlink target is outside the container filesystem');
  });

  it('resolves an ordinary in-mount symlink to its target file', async() => {
    const vm = mockResolveVM({
      statByName: {
        'safe-link':     ['1', 'symbolic link', '', '', 'lrwxrwxrwx', 'real-file.txt', `${ MOUNT_ROOT }/real-file.txt`, '1'].join('\t'),
        'real-file.txt': ['0', 'regular file', '42', '1700000000', '-rw-r--r--', '', '', '0'].join('\t'),
      },
      readlinkResult: `${ MOUNT_ROOT }/real-file.txt`,
    });

    const result = await resolveRegularFileAt(vm, MOUNT_ROOT, '/safe-link', 'preview');

    expect(result.targetPath).toBe('/real-file.txt');
    expect(result.stat.kind).toBe('file');
  });

  it('rejects a symlink whose target resolves to something other than a regular file', async() => {
    const vm = mockResolveVM({
      statByName: {
        'dir-link': ['1', 'symbolic link', '', '', 'lrwxrwxrwx', 'some-dir', `${ MOUNT_ROOT }/some-dir`, '1'].join('\t'),
        'some-dir': ['0', 'directory', '', '1700000000', 'drwxr-xr-x', '', '', '0'].join('\t'),
      },
      readlinkResult: `${ MOUNT_ROOT }/some-dir`,
    });

    await expect(resolveRegularFileAt(vm, MOUNT_ROOT, '/dir-link', 'download'))
      .rejects.toThrow('not a regular file');
  });
});

/** Build a mocked VMExecutor whose single-round-trip execCommand always returns `output`. */
function mockSearchVM(output: string): VMExecutor {
  return {
    backend:     'lima',
    execCommand: jest.fn(() => Promise.resolve(output)),
  } as unknown as VMExecutor;
}

describe('searchFilesAt', () => {
  it('matches case-insensitively on basename and classifies kind', async() => {
    // Deliberately scrambled input order -- proves the result is sorted,
    // not just passed through in whatever order `find` happened to return.
    const output = [
      'usr/local/config\tdirectory',
      'etc/sub/config-link\tsymlink',
      'etc/config.yaml\tfile',
    ].join('\n');
    const vm = mockSearchVM(output);
    const result = await searchFilesAt(vm, MOUNT_ROOT, 'CONFIG');

    expect(result.query).toBe('CONFIG');
    expect(result.truncated).toBe(false);
    expect(result.totalMatchCount).toBe(3);
    expect(result.matches).toEqual([
      { path: '/etc/config.yaml', kind: 'file' },
      { path: '/etc/sub/config-link', kind: 'symlink' },
      { path: '/usr/local/config', kind: 'directory' },
    ]);
  });

  it('orders a directory immediately before its own matched children, and distinguishes it from an unrelated same-prefix sibling', async() => {
    const output = [
      'src/utils/helpers.ts\tfile',
      'src\tdirectory',
      'srcbackup\tdirectory',
    ].join('\n');
    const vm = mockSearchVM(output);
    const result = await searchFilesAt(vm, MOUNT_ROOT, 'src');

    expect(result.matches.map(m => m.path)).toEqual(['/src', '/src/utils/helpers.ts', '/srcbackup']);
  });

  it('does not call execCommand for an empty or whitespace-only query', async() => {
    const vm = mockSearchVM('should not be used');
    const result = await searchFilesAt(vm, MOUNT_ROOT, '   ');

    expect(result).toEqual({
      query: '   ', matches: [], truncated: false, totalMatchCount: 0,
    });
    expect((vm.execCommand as jest.Mock)).not.toHaveBeenCalled();
  });

  it('reports truncation without an exact total when matches exceed the cap, keeping the first matches in tree order', async() => {
    // maxMatches: 2 -> the script is asked to cap at 3 lines; 3 lines back means "more exist".
    // Sorted before truncating, so the alphabetically-last entry ("c/three") is the one dropped,
    // regardless of what order `find` returned them in.
    const output = ['c/three\tfile', 'a/one\tfile', 'b/two\tfile'].join('\n');
    const vm = mockSearchVM(output);
    const result = await searchFilesAt(vm, MOUNT_ROOT, 'e', { maxMatches: 2 });

    expect(result.truncated).toBe(true);
    expect(result.totalMatchCount).toBeNull();
    expect(result.matches).toEqual([
      { path: '/a/one', kind: 'file' },
      { path: '/b/two', kind: 'file' },
    ]);
  });

  it('behaves identically against a runtime-fs (/proc/<pid>/root) mount root', async() => {
    const output = 'proc-visible/file.txt\tfile';
    const vm = mockSearchVM(output);
    const result = await searchFilesAt(vm, '/proc/4242/root', 'file');

    expect(result.matches).toEqual([{ path: '/proc-visible/file.txt', kind: 'file' }]);
  });

  it('prunes the top-level /proc, /sys, and /dev entries from the traversal', async() => {
    // These are the OCI runtime's own live mounts into a *running* container's
    // namespace (see runtimeFsMount.ts) -- kernel-virtual trees with thousands
    // of synthetic entries, not real files, and not part of a stopped
    // container's snapshot/overlay mount at all. Walking them is what made
    // search visibly slower against a running container than a stopped one.
    let capturedScript = '';
    const vm = {
      backend:     'lima',
      execCommand: jest.fn((...args: any[]) => {
        const command = typeof args[0] === 'object' ? args.slice(1) : args;

        capturedScript = command[2] as string;

        return Promise.resolve('');
      }),
    } as unknown as VMExecutor;

    await searchFilesAt(vm, MOUNT_ROOT, 'anything');

    expect(capturedScript).toContain('-prune');
    expect(capturedScript).toContain('-path ./proc');
    expect(capturedScript).toContain('-path ./sys');
    expect(capturedScript).toContain('-path ./dev');
  });
});
