import debounce from 'lodash/debounce';
import { defineComponent } from 'vue';

import type { ContainerSearchMatch, ContainerSearchResult } from '@pkg/backend/containerClient/fileTypes';
import { ancestorPathsOf, generateRequestId } from '@pkg/components/containerFilesHelpers';
import type { TreeNode } from '@pkg/components/containerFilesTypes';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * Instant local filtering plus on-demand full-filesystem search for
 * ContainerFiles.vue's file tree. Split out as its own mixin, but unlike
 * paneResizeMixin.ts this one isn't fully self-contained -- it still needs a
 * few things only the host tree/session state owns (which directory nodes
 * are loaded, how to load one, the current container, and how to tell a
 * stale search response from a live one). `FileSearchMixinHost` documents
 * exactly that boundary; TypeScript has no way to verify a mixin's `this`
 * against a host it doesn't know about yet, so those specific accesses go
 * through an explicit (typed, not `any`) cast rather than silently
 * type-checking against the wrong thing.
 */
interface FileSearchMixinHost {
  containerId:     string;
  nodes:           Record<string, TreeNode>;
  ensureDirLoaded: (dirPath: string) => Promise<TreeNode>;
  isStaleSearch:   (containerId: string, requestId: string) => boolean;
}

interface FileSearchMixinData {
  // Instant local filter (over whatever's already loaded/expanded).
  searchInput:               string; // raw, updated every keystroke
  filterQuery:               string; // debounced copy that actually drives filtering
  debouncedSetFilterQuery:   ((value: string) => void) | null;
  // On-demand full-filesystem search.
  fullSearchStatus:          'idle' | 'searching' | 'done' | 'error';
  fullSearchMatches:         ContainerSearchMatch[];
  fullSearchTruncated:       boolean;
  fullSearchTotalMatchCount: number | null;
  fullSearchRequestId:       string | null;
  fullSearchCurrentIndex:    number;
  fullSearchError:           string | null;
  highlightedMatchPath:      string | null;
  // Indices into fullSearchMatches whose ancestors have finished being
  // revealed (successfully or not) -- a Set, not a raw counter, so
  // re-revealing an already-revealed match (e.g. navigating back to it)
  // can't double-count it.
  revealedMatchIndices:      Set<number>;
  // Invalidates every in-flight ancestor-expand-and-reveal walk from the
  // current search batch (e.g. a newer search superseding it, or a
  // container reset) without needing to cancel the underlying promises
  // they're awaiting -- shared across all matches' walks, unlike
  // navigationSequence below.
  expandWalkGeneration:      number;
  // Invalidates only a specific in-flight jumpToMatch() call (e.g. rapid
  // next/previous clicks), independent of the broader reveal-all-matches
  // batch tracked by expandWalkGeneration.
  navigationSequence:        number;
}

export default defineComponent({
  data(): FileSearchMixinData {
    return {
      searchInput:              '',
      filterQuery:              '',
      debouncedSetFilterQuery:  null,

      fullSearchStatus:          'idle',
      fullSearchMatches:         [],
      fullSearchTruncated:       false,
      fullSearchTotalMatchCount: null,
      fullSearchRequestId:       null,
      fullSearchCurrentIndex:    0,
      fullSearchError:           null,
      highlightedMatchPath:      null,
      revealedMatchIndices:      new Set(),
      expandWalkGeneration:      0,
      navigationSequence:        0,
    };
  },
  computed: {
    /** Lowercased once here rather than by every recursive tree node. */
    filterTerm(): string {
      return this.filterQuery.trim().toLowerCase();
    },
    /** True once a local filter is active and nothing loaded/expanded matches it anywhere. */
    noLocalMatches(): boolean {
      return this.filterTerm !== '' && !this.subtreeHasMatch('/', this.filterTerm);
    },
    revealedMatchCount(): number {
      return this.revealedMatchIndices.size;
    },
  },
  watch: {
    searchInput(neu: string) {
      // Clearing the box -- whether by backspacing or the search input's own
      // native "x" -- resets everything immediately, not just the (debounced)
      // local filter; otherwise a stale full-search banner/highlight could
      // outlive the query that produced it.
      if (neu === '') {
        this.clearSearch();
      } else {
        this.debouncedSetFilterQuery?.(neu);
      }
    },
  },
  created() {
    this.debouncedSetFilterQuery = debounce((value: string) => {
      this.filterQuery = value;
    }, 200);
  },
  mounted() {
    ipcRenderer.on('container-files/search-result', this.onSearchResult);
    ipcRenderer.on('container-files/search-error', this.onSearchError);
  },
  beforeUnmount() {
    ipcRenderer.removeAllListeners('container-files/search-result');
    ipcRenderer.removeAllListeners('container-files/search-error');
  },
  methods: {
    /**
     * True if `dirPath` or anything in its already-loaded subtree matches
     * `term` (case-insensitive substring on name). Recurses over any node
     * with entries !== null regardless of its current `expanded` state, so
     * collapsing a matched subdirectory doesn't hide its own row -- folders
     * never opened aren't searched at all, by design.
     */
    subtreeHasMatch(dirPath: string, term: string): boolean {
      const { nodes } = this as unknown as FileSearchMixinHost;
      const node = nodes[dirPath];

      if (!node?.entries) return false;

      return node.entries.some(entry => entry.name.toLowerCase().includes(term) ||
        (entry.kind === 'directory' && this.subtreeHasMatch(entry.path, term)));
    },
    runFullSearch() {
      const query = this.searchInput.trim();

      if (!query) return;
      // Invalidate any still-running reveal walk from a previous search
      // immediately, even before this one's results arrive.
      this.expandWalkGeneration++;
      this.fullSearchStatus = 'searching';
      this.fullSearchError = null;
      this.fullSearchMatches = [];
      this.fullSearchTruncated = false;
      this.fullSearchTotalMatchCount = null;
      this.fullSearchCurrentIndex = 0;
      this.highlightedMatchPath = null;
      this.revealedMatchIndices = new Set();
      const requestId = generateRequestId();

      this.fullSearchRequestId = requestId;
      const { containerId } = this as unknown as FileSearchMixinHost;

      ipcRenderer.send('container-files/search', requestId, containerId, query);
    },
    onSearchResult(_event: unknown, requestId: string, containerId: string, result: ContainerSearchResult) {
      if ((this as unknown as FileSearchMixinHost).isStaleSearch(containerId, requestId)) return;
      this.fullSearchStatus = 'done';
      this.fullSearchMatches = result.matches;
      this.fullSearchTruncated = result.truncated;
      this.fullSearchTotalMatchCount = result.totalMatchCount;
      this.fullSearchCurrentIndex = 0;
      if (result.matches.length > 0) {
        this.jumpToMatch(0);
        this.revealRemainingMatches(result.matches);
      }
    },
    onSearchError(_event: unknown, requestId: string, containerId: string, message: string) {
      if ((this as unknown as FileSearchMixinHost).isStaleSearch(containerId, requestId)) return;
      this.fullSearchStatus = 'error';
      this.fullSearchError = message;
    },
    searchNext() {
      const matchCount = this.fullSearchMatches.length;

      if (matchCount === 0) return;
      this.jumpToMatch((this.fullSearchCurrentIndex + 1) % matchCount);
    },
    searchPrevious() {
      const matchCount = this.fullSearchMatches.length;

      if (matchCount === 0) return;
      this.jumpToMatch((this.fullSearchCurrentIndex - 1 + matchCount) % matchCount);
    },
    /**
     * Expands/loads every ancestor directory down to `path` (fetching any
     * not yet loaded), without scrolling or highlighting anything -- the
     * building block both jumpToMatch() and revealRemainingMatches() share.
     * `generation` is a snapshot of expandWalkGeneration taken by the
     * caller at the *batch's* start (a whole search, or a container reset)
     * -- not bumped per-call -- so many of these can run concurrently for
     * different matches from the same search without aborting each other;
     * they only abort if a *newer* search/reset supersedes the batch.
     * Returns false if superseded or if a fetch genuinely failed.
     */
    async revealPath(path: string, generation: number): Promise<boolean> {
      const { ensureDirLoaded } = this as unknown as FileSearchMixinHost;

      try {
        for (const dirPath of ancestorPathsOf(path)) {
          await ensureDirLoaded(dirPath);
          if (generation !== this.expandWalkGeneration) return false;
        }

        return true;
      } catch {
        return false;
      }
    },
    /**
     * Reveals every match beyond index 0 (jumpToMatch(0) already reveals
     * that one) in the background, so the whole result set becomes visible
     * in the tree without clicking through each one individually. Matches
     * stream in as each shared ancestor directory's listing resolves
     * (ensureDirLoaded() dedupes concurrent requests for the same
     * directory), rather than all appearing at once -- deliberately not
     * awaited or surfaced as an error; a background reveal failing quietly
     * for one match shouldn't affect the others.
     */
    revealRemainingMatches(matches: ContainerSearchMatch[]) {
      const generation = this.expandWalkGeneration;

      matches.forEach((match, index) => {
        if (index === 0) return;
        this.revealPath(match.path, generation).then(() => this.markRevealed(index, generation));
      });
    },
    /**
     * Records that fullSearchMatches[index]'s reveal has settled, unless a
     * newer search/reset has since superseded `generation`.
     */
    markRevealed(index: number, generation: number) {
      if (generation !== this.expandWalkGeneration) return;
      this.revealedMatchIndices.add(index);
    },
    /**
     * Reveals fullSearchMatches[index] (see revealPath()), then scrolls to
     * and highlights it as the current match. `navigationSequence` (bumped
     * on every call, unlike the shared `generation` snapshot) lets a newer
     * jump/next/previous supersede an in-flight one -- e.g. rapid double
     * clicks -- without that also aborting the unrelated background reveal
     * of other matches.
     */
    async jumpToMatch(index: number) {
      const match = this.fullSearchMatches[index];

      if (!match) return;
      this.fullSearchCurrentIndex = index;
      const generation = this.expandWalkGeneration;
      const navigation = ++this.navigationSequence;
      const revealed = await this.revealPath(match.path, generation);

      this.markRevealed(index, generation);
      if (generation !== this.expandWalkGeneration || navigation !== this.navigationSequence) return;
      if (!revealed) {
        this.fullSearchError = this.t('containerFiles.search.revealFailed', { path: match.path });

        return;
      }
      await this.$nextTick();
      if (generation !== this.expandWalkGeneration || navigation !== this.navigationSequence) return;
      this.scrollToRow(match.path);
    },
    scrollToRow(path: string) {
      const el = (this.$el as HTMLElement).querySelector(`[data-tree-row-path="${ CSS.escape(path) }"]`);

      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      this.highlightedMatchPath = path;
    },
    /** Resets both the instant local filter and the full-search state -- they share one text box. */
    clearSearch() {
      this.searchInput = '';
      this.filterQuery = '';
      this.expandWalkGeneration++;
      this.navigationSequence++;
      this.fullSearchStatus = 'idle';
      this.fullSearchMatches = [];
      this.fullSearchTruncated = false;
      this.fullSearchTotalMatchCount = null;
      this.fullSearchRequestId = null;
      this.fullSearchCurrentIndex = 0;
      this.fullSearchError = null;
      this.highlightedMatchPath = null;
      this.revealedMatchIndices = new Set();
    },
  },
});
