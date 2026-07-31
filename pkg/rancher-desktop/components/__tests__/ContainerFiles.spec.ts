import type { ContainerDirectoryEntry } from '@pkg/backend/containerClient/fileTypes';

import {
  ancestorPathsOf, generateRequestId, highlightSegments, isDownloadableEntry, isInertEntry, relativeContainerPath,
} from '../containerFilesHelpers';

function entry(overrides: Partial<ContainerDirectoryEntry>): ContainerDirectoryEntry {
  return {
    name:               'name',
    path:               '/name',
    kind:               'file',
    size:               0,
    mode:               'rw-r--r--',
    mtime:              null,
    symlinkTarget:      null,
    symlinkEscapesRoot: false,
    permissionDenied:   false,
    ...overrides,
  };
}

describe('generateRequestId', () => {
  it('produces a non-empty string', () => {
    expect(generateRequestId()).toEqual(expect.any(String));
    expect(generateRequestId().length).toBeGreaterThan(0);
  });

  it('does not collide across many calls', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => generateRequestId()));

    expect(ids.size).toBe(1_000);
  });
});

describe('ancestorPathsOf', () => {
  it('returns every ancestor directory down to (not including) the match itself', () => {
    expect(ancestorPathsOf('/usr/local/bin/nerdctl')).toEqual(['/', '/usr', '/usr/local', '/usr/local/bin']);
  });

  it('returns just the root for a top-level file', () => {
    expect(ancestorPathsOf('/etc')).toEqual(['/']);
  });

  it('handles a bare root path without producing empty segments', () => {
    expect(ancestorPathsOf('/')).toEqual(['/']);
  });
});

describe('highlightSegments', () => {
  it('returns the whole name unmatched when there is no search term', () => {
    expect(highlightSegments('config.yaml', '')).toEqual([{ text: 'config.yaml', matched: false }]);
  });

  it('splits out a single case-insensitive match in the middle of the name', () => {
    expect(highlightSegments('MyConfigFile.yaml', 'config')).toEqual([
      { text: 'My', matched: false },
      { text: 'Config', matched: true },
      { text: 'File.yaml', matched: false },
    ]);
  });

  it('handles a match at the very start of the name, with nothing before it', () => {
    expect(highlightSegments('config.yaml', 'config')).toEqual([
      { text: 'config', matched: true },
      { text: '.yaml', matched: false },
    ]);
  });

  it('handles a match at the very end of the name, with nothing after it', () => {
    expect(highlightSegments('my.config', 'config')).toEqual([
      { text: 'my.', matched: false },
      { text: 'config', matched: true },
    ]);
  });

  it('highlights every occurrence when the term repeats in the name', () => {
    expect(highlightSegments('foo-foo-bar', 'foo')).toEqual([
      { text: 'foo', matched: true },
      { text: '-', matched: false },
      { text: 'foo', matched: true },
      { text: '-bar', matched: false },
    ]);
  });

  it('returns no matches when the term does not appear', () => {
    expect(highlightSegments('config.yaml', 'zzz')).toEqual([{ text: 'config.yaml', matched: false }]);
  });
});

describe('relativeContainerPath', () => {
  it('strips the leading slash from an absolute container path', () => {
    expect(relativeContainerPath('/etc/hosts')).toEqual('etc/hosts');
  });

  it('leaves the root path as an empty string', () => {
    expect(relativeContainerPath('/')).toEqual('');
  });
});

describe('isInertEntry', () => {
  it('is true for a symlink whose target escapes the container root', () => {
    expect(isInertEntry(entry({ kind: 'symlink', symlinkEscapesRoot: true }))).toBe(true);
  });

  it('is false for a symlink whose target stays inside the container root', () => {
    expect(isInertEntry(entry({ kind: 'symlink', symlinkEscapesRoot: false }))).toBe(false);
  });

  it('is false for a regular file', () => {
    expect(isInertEntry(entry({ kind: 'file' }))).toBe(false);
  });
});

describe('isDownloadableEntry', () => {
  it('is true for a regular file', () => {
    expect(isDownloadableEntry(entry({ kind: 'file' }))).toBe(true);
  });

  it('is true for a symlink that stays inside the container root', () => {
    expect(isDownloadableEntry(entry({ kind: 'symlink', symlinkEscapesRoot: false }))).toBe(true);
  });

  it('is false for an inert (escaping) symlink', () => {
    expect(isDownloadableEntry(entry({ kind: 'symlink', symlinkEscapesRoot: true }))).toBe(false);
  });

  it('is false for a directory', () => {
    expect(isDownloadableEntry(entry({ kind: 'directory' }))).toBe(false);
  });

  it('is false for other filesystem entry kinds (sockets, FIFOs, devices)', () => {
    expect(isDownloadableEntry(entry({ kind: 'other' }))).toBe(false);
  });
});
