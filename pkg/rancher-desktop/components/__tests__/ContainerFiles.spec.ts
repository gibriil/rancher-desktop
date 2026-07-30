import { ancestorPathsOf, generateRequestId, highlightSegments } from '../containerFilesHelpers';

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
