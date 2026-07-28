/** @jest-environment node */

import { jest } from '@jest/globals';

import type { VMExecutor } from '@pkg/backend/backend';
import { listDirectoryAt, searchFilesAt, statPathAt } from '@pkg/backend/containerClient/containerFsOps';
import { parseDiffOutput, parseMountsOutput } from '@pkg/backend/containerClient/dockerFormatParsers';

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
});
