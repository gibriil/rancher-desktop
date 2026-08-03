<template>
  <div :class="{ 'container-files-component': true, resizing: resizingPreviewPane }">
    <banner
      v-if="capabilitiesError"
      class="content-state"
      color="error"
      data-testid="files-capabilities-error"
    >
      <span class="icon icon-warning icon-lg" />
      {{ t('containerFiles.capabilitiesError', { error: capabilitiesError }) }}
    </banner>

    <banner
      v-else-if="capabilities && !capabilities.supported"
      class="content-state"
      color="warning"
      data-testid="files-unavailable"
    >
      <span class="icon icon-info-circle icon-lg" />
      {{ capabilities.reason || t('containerFiles.unavailable') }}
    </banner>

    <template v-else>
      <div class="files-header">
        <badge-state
          :color="isContainerRunning ? 'bg-success' : 'bg-darker'"
          :label="containerState"
          class="state-indicator"
          data-testid="files-state-indicator"
        />
        <icon-button
          class="btn btn-sm role-tertiary"
          :icon="anyLoading ? 'icon icon-spinner icon-spin' : 'icon icon-refresh'"
          :disabled="anyLoading"
          :aria-label="t('containerFiles.refresh')"
          test-id="files-refresh"
          @click="refresh"
        />
        <container-file-search
          v-model="searchInput"
          :status="fullSearchStatus"
          :match-count="fullSearchMatches.length"
          :revealed-count="revealedMatchCount"
          :current-index="fullSearchCurrentIndex"
          @search="runFullSearch"
          @next="searchNext"
          @previous="searchPrevious"
        />
      </div>

      <banner
        v-if="noLocalMatches"
        color="info"
        data-testid="files-no-local-matches"
      >
        {{ t('containerFiles.search.noLocalMatches', { query: filterQuery.trim() }) }}
      </banner>

      <banner
        v-if="fullSearchStatus === 'error' && fullSearchError"
        color="error"
        data-testid="files-search-error"
      >
        {{ fullSearchError }}
      </banner>

      <banner
        v-if="fullSearchStatus === 'done' && fullSearchMatches.length === 0"
        color="info"
        data-testid="files-search-no-results"
      >
        {{ t('containerFiles.search.noResults', { query: searchInput.trim() }) }}
      </banner>

      <banner
        v-if="fullSearchTruncated"
        color="warning"
        data-testid="files-search-truncated"
      >
        {{ t('containerFiles.search.truncated', { shown: fullSearchMatches.length }) }}
      </banner>

      <div
        ref="filePanel"
        class="file-panel"
      >
        <div class="tree-header">
          <span class="tree-header-primary">{{ t('containerFiles.table.header.name') }}</span>
          <span class="tree-header-meta">
            <span class="meta-size">{{ t('containerFiles.table.header.size') }}</span>
            <span class="meta-modified">{{ t('containerFiles.table.header.modified') }}</span>
            <span class="meta-permissions">{{ t('containerFiles.table.header.permissions') }}</span>
          </span>
        </div>
        <div
          class="file-tree"
          role="tree"
          data-testid="file-tree"
        >
          <loading-indicator
            v-if="rootNode.loading && !rootNode.entries"
            class="content-state"
          >
            {{ t('containerFiles.loading') }}
          </loading-indicator>

          <banner
            v-else-if="rootNode.error"
            class="content-state"
            color="error"
            data-testid="files-error"
          >
            <span class="icon icon-info-circle icon-lg" />
            {{ rootNode.error }}
          </banner>

          <container-file-tree-node
            v-else
            path="/"
            :depth="0"
            :context="treeContext"
          />
        </div>
      </div>

      <template v-if="selectedPath">
        <div
          ref="resizeHandle"
          class="resize-handle"
          role="separator"
          aria-orientation="horizontal"
          :aria-label="t('containerFiles.resizeHandle.ariaLabel')"
          :aria-valuenow="Math.round(paneBounds().current)"
          :aria-valuemin="Math.round(paneBounds().min)"
          :aria-valuemax="Math.round(paneBounds().max)"
          tabindex="0"
          data-testid="preview-resize-handle"
          @mousedown="startResize"
          @dblclick="resetPaneHeight"
          @keydown="onHandleKeydown"
        />

        <div
          ref="previewPane"
          class="preview-pane"
          data-testid="file-preview"
          :style="previewPaneHeight ? { height: `${previewPaneHeight}px`, maxHeight: 'none' } : undefined"
        >
          <div class="preview-header">
            <span class="preview-path">{{ selectedPath }}</span>
            <icon-button
              class="btn btn-sm role-tertiary"
              icon="icon icon-close"
              :aria-label="t('generic.close')"
              test-id="preview-close"
              @click="closePreview"
            />
          </div>

          <loading-indicator v-if="previewLoading">
            {{ t('containerFiles.previewLoading') }}
          </loading-indicator>

          <banner
            v-else-if="previewError"
            color="error"
          >
            {{ previewError }}
          </banner>

          <template v-else-if="preview">
            <banner
              v-if="preview.kind === 'too-large' || preview.kind === 'binary'"
              color="info"
              data-testid="preview-download-only"
            >
              <span>{{
                preview.kind === 'too-large'
                  ? t('containerFiles.tooLarge', { size: formatSize(preview.totalSize) })
                  : t('containerFiles.binaryFile')
              }}</span>
              <button
                class="btn btn-sm role-primary download-btn"
                @click="downloadFile(selectedPath)"
              >
                {{ t('containerFiles.download') }}
              </button>
            </banner>
            <pre
              v-else
              class="preview-content"
            >{{ preview.content }}</pre>
          </template>

          <div
            v-if="downloadMessage"
            class="download-message"
          >
            {{ downloadMessage }}
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { BadgeState, Banner } from '@rancher/components';
import { clipboard } from 'electron';
import { defineComponent } from 'vue';
import { mapGetters } from 'vuex';

import type {
  ContainerDiffEntry, ContainerDirectoryEntry, ContainerDirectoryListing, ContainerFilePreview,
  ContainerFilesCapabilities, ContainerMountInfo,
} from '@pkg/backend/containerClient/fileTypes';
import ContainerFileSearch from '@pkg/components/ContainerFileSearch.vue';
import ContainerFileTreeNode from '@pkg/components/ContainerFileTreeNode.vue';
import IconButton from '@pkg/components/IconButton.vue';
import LoadingIndicator from '@pkg/components/LoadingIndicator.vue';
import {
  diffBadgeColor, formatDate, formatSize, generateRequestId, getFileIcon, highlightSegments, isDownloadableEntry,
  relativeContainerPath,
} from '@pkg/components/containerFilesHelpers';
import type { TreeNode } from '@pkg/components/containerFilesTypes';
import fileSearchMixin from '@pkg/components/mixins/fileSearchMixin';
import paneResizeMixin from '@pkg/components/mixins/paneResizeMixin';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * The shape ContainerFileTreeNode.vue's `context` prop actually receives --
 * exported so that component can type it precisely (Object as
 * PropType<TreeContext>) instead of a bare `type: Object`, matching this
 * codebase's own established typed-object-prop convention rather than
 * leaving the single most complex value threaded through this feature
 * untyped.
 */
export interface TreeContext {
  nodes:                Record<string, TreeNode>;
  decorate:             (entry: ContainerDirectoryEntry) => { diffStatus: ContainerDiffEntry['status'] | null, mountInfo: ContainerMountInfo | null };
  onToggleDir:          (dirPath: string) => void;
  onSelectFile:         (entry: ContainerDirectoryEntry) => void;
  /** Builds the `resources` entry ActionMenu.vue's `action-menu` store consumes for this row's right-click/keyboard menu. */
  menuResourceFor:      (entry: ContainerDirectoryEntry) => Record<string, unknown>;
  /**
   * The row that currently holds real DOM focus, and the row whose context
   * menu is currently open -- tracked as explicit state here (rather than
   * relying solely on :focus-visible) because opening the menu moves actual
   * DOM focus off the row and onto a menu item, which would otherwise drop
   * the row's focus indicator for as long as the menu stays open.
   */
  focusedPath:          string | null;
  menuOpenPath:         string | null;
  onRowFocus:           (path: string) => void;
  onRowBlur:            (path: string) => void;
  onMenuOpen:           (path: string) => void;
  formatSize:           (bytes: number | null) => string;
  formatDate:           (mtime: string | null) => string;
  getFileIcon:          (entry: ContainerDirectoryEntry) => string;
  diffBadgeColor:       (status: ContainerDiffEntry['status']) => string;
  filterTerm:           string;
  subtreeHasMatch:      (dirPath: string, term: string) => boolean;
  highlightSegments:    (name: string, term: string) => { text: string, matched: boolean }[];
  highlightedMatchPath: string | null;
  t:                    (key: string, args?: Record<string, unknown>) => string;
}

function freshNode(expanded: boolean): TreeNode {
  return {
    entries: null, expanded, loading: false, error: null, truncated: false, totalEntryCount: null, requestId: null,
  };
}

interface ListWaiter {
  resolve: (node: TreeNode) => void;
  reject:  (err: Error) => void;
}

interface Data {
  capabilities:              ContainerFilesCapabilities | null;
  capabilitiesError:         string | null;
  nodes:                     Record<string, TreeNode>;
  pendingListRequests:       Record<string, string>; // requestId -> path
  pendingListPromises:       Record<string, ListWaiter[]>; // requestId -> waiters for ensureDirLoaded()
  diffEntries:               ContainerDiffEntry[];
  mountedPaths:              ContainerMountInfo[];
  selectedPath:              string | null;
  preview:                   ContainerFilePreview | null;
  previewLoading:            boolean;
  previewError:              string | null;
  downloadMessage:           string | null;
  previewRequestId:          string | null;
  // See TreeContext's own doc comment on focusedPath/menuOpenPath.
  focusedPath:               string | null;
  menuOpenPath:              string | null;
}

export default defineComponent({
  name:   'container-files',
  mixins: [paneResizeMixin, fileSearchMixin],
  components: {
    BadgeState,
    Banner,
    ContainerFileSearch,
    ContainerFileTreeNode,
    IconButton,
    LoadingIndicator,
  },
  props: {
    containerId: {
      type:     String,
      required: true,
    },
    isContainerRunning: {
      type:    Boolean,
      default: false,
    },
    containerState: {
      type:    String,
      default: '',
    },
    namespace: {
      type:    String,
      default: undefined,
    },
  },
  data(): Data {
    return {
      capabilities:        null,
      capabilitiesError:   null,
      nodes:               { '/': freshNode(true) },
      pendingListRequests: {},
      pendingListPromises: {},
      diffEntries:         [],
      mountedPaths:        [],
      selectedPath:        null,
      preview:             null,
      previewLoading:      false,
      previewError:        null,
      downloadMessage:     null,
      previewRequestId:    null,
      focusedPath:         null,
      menuOpenPath:        null,
    };
  },
  computed: {
    ...mapGetters({ isActionMenuShowing: 'action-menu/showing' }),
    rootNode(): TreeNode {
      return this.nodes['/'];
    },
    anyLoading(): boolean {
      return Object.values(this.nodes).some(node => node.loading);
    },
    diffByPath(): Record<string, ContainerDiffEntry['status']> {
      const map: Record<string, ContainerDiffEntry['status']> = {};

      for (const entry of this.diffEntries) {
        map[entry.path] = entry.status;
      }

      return map;
    },
    mountsByPath(): Record<string, ContainerMountInfo> {
      const map: Record<string, ContainerMountInfo> = {};

      for (const mount of this.mountedPaths) {
        map[mount.destination] = mount;
      }

      return map;
    },
    /**
     * Bundled once and passed by reference to every level of the recursive
     * tree, rather than threading half a dozen individual props through
     * each recursion -- ContainerFiles.vue stays the single owner of
     * `nodes`/diff/mounts state and IPC, the tree nodes just read/dispatch
     * through this.
     */
    treeContext(): TreeContext {
      return {
        nodes:                this.nodes,
        decorate:             this.decorate,
        onToggleDir:          this.toggleDir,
        onSelectFile:         this.selectFile,
        menuResourceFor:      this.menuResourceFor,
        focusedPath:          this.focusedPath,
        menuOpenPath:         this.menuOpenPath,
        onRowFocus:           this.onRowFocus,
        onRowBlur:            this.onRowBlur,
        onMenuOpen:           this.onMenuOpen,
        formatSize,
        formatDate,
        getFileIcon,
        diffBadgeColor,
        filterTerm:           this.filterTerm,
        subtreeHasMatch:      this.subtreeHasMatch,
        highlightSegments,
        highlightedMatchPath: this.highlightedMatchPath,
        // `t` is a global property (installed by the i18n plugin), not a
        // component method, so Vue doesn't auto-bind it to `this` the way
        // it does everything else above -- wrap it or lose `this.$store`
        // once it's called as `context.t(...)` instead of `this.t(...)`.
        t:                    (key: string, args?: Record<string, unknown>) => this.t(key, args),
      };
    },
  },
  watch: {
    containerId() {
      this.resetAndOpen();
    },
    /** The global action-menu closing is the only signal we get that a row's open menu is done -- nothing else calls back into this component when it's dismissed. */
    isActionMenuShowing(showing: boolean) {
      if (!showing) {
        this.menuOpenPath = null;
      }
    },
  },
  mounted() {
    ipcRenderer.on('container-files/capabilities', this.onCapabilities);
    ipcRenderer.on('container-files/capabilities-error', this.onCapabilitiesError);
    ipcRenderer.on('container-files/list-result', this.onListResult);
    ipcRenderer.on('container-files/list-error', this.onListError);
    ipcRenderer.on('container-files/preview-result', this.onPreviewResult);
    ipcRenderer.on('container-files/preview-error', this.onPreviewError);
    ipcRenderer.on('container-files/diff-result', this.onDiffResult);
    ipcRenderer.on('container-files/diff-error', this.onDiffError);
    ipcRenderer.on('container-files/mounts-result', this.onMountsResult);
    ipcRenderer.on('container-files/mounts-error', this.onMountsError);
    ipcRenderer.on('container-files/download-done', this.onDownloadDone);
    ipcRenderer.on('container-files/download-error', this.onDownloadError);
    ipcRenderer.on('container-files/stopped', this.onStopped);

    this.openSession();
  },
  beforeUnmount() {
    ipcRenderer.send('container-files/close', this.containerId);
    ipcRenderer.removeAllListeners('container-files/capabilities');
    ipcRenderer.removeAllListeners('container-files/capabilities-error');
    ipcRenderer.removeAllListeners('container-files/list-result');
    ipcRenderer.removeAllListeners('container-files/list-error');
    ipcRenderer.removeAllListeners('container-files/preview-result');
    ipcRenderer.removeAllListeners('container-files/preview-error');
    ipcRenderer.removeAllListeners('container-files/diff-result');
    ipcRenderer.removeAllListeners('container-files/diff-error');
    ipcRenderer.removeAllListeners('container-files/mounts-result');
    ipcRenderer.removeAllListeners('container-files/mounts-error');
    ipcRenderer.removeAllListeners('container-files/download-done');
    ipcRenderer.removeAllListeners('container-files/download-error');
    ipcRenderer.removeAllListeners('container-files/stopped');
  },
  methods: {
    resetAndOpen() {
      ipcRenderer.send('container-files/close', this.containerId);
      this.capabilities = null;
      this.capabilitiesError = null;
      this.pendingListRequests = {};
      // Any waiter still pending belonged to the tree that's about to be
      // thrown away -- reject rather than leaving it to hang forever, since
      // a stale response (if it ever arrives) will be dropped by
      // onListResult/onListError's own containerId guard before it reaches
      // the settling logic below.
      for (const waiters of Object.values(this.pendingListPromises)) {
        for (const waiter of waiters) {
          waiter.reject(new Error('Container files session was reset'));
        }
      }
      this.pendingListPromises = {};
      this.nodes = { '/': freshNode(true) };
      this.diffEntries = [];
      this.mountedPaths = [];
      this.closePreview();
      this.clearSearch();
      this.openSession();
    },
    /**
     * True if an IPC response naming `containerId` belongs to a since-
     * abandoned container (the user switched tabs/containers before it
     * arrived) rather than the one currently open. This same one-line check
     * was previously copy-pasted verbatim into 9 separate IPC callbacks;
     * three more callbacks need it plus one further staleness check specific
     * to that response kind (a superseded preview/selection/search request)
     * -- see isStalePreview/isStaleSelection/isStaleSearch below.
     */
    isStale(containerId: string): boolean {
      return containerId !== this.containerId;
    },
    /** Stale for a preview/download response: wrong container, or superseded by a newer preview request. */
    isStalePreview(containerId: string, requestId: string): boolean {
      return this.isStale(containerId) || requestId !== this.previewRequestId;
    },
    /** Stale for a preview lifecycle event keyed by path rather than requestId (close/download-done/-error). */
    isStaleSelection(containerId: string, filePath: string): boolean {
      return this.isStale(containerId) || filePath !== this.selectedPath;
    },
    /** Stale for a full-search response: wrong container, or superseded by a newer search request. */
    isStaleSearch(containerId: string, requestId: string): boolean {
      return this.isStale(containerId) || requestId !== this.fullSearchRequestId;
    },
    openSession() {
      ipcRenderer.send('container-files/open', this.containerId, this.namespace);
      ipcRenderer.send('container-files/diff', this.containerId);
      ipcRenderer.send('container-files/mounts', this.containerId);
      this.requestList('/');
    },
    onCapabilities(_event: unknown, containerId: string, result: ContainerFilesCapabilities) {
      if (this.isStale(containerId)) return;
      this.capabilities = result;
    },
    onCapabilitiesError(_event: unknown, containerId: string, message: string) {
      if (this.isStale(containerId)) return;
      this.capabilitiesError = message;
    },
    onStopped(_event: unknown, containerId: string) {
      if (this.isStale(containerId)) return;
      this.rootNode.error = this.t('containerFiles.sessionStopped');
      this.rootNode.loading = false;
    },
    /** Fetches (or re-fetches) a single node's children; the node must already exist in `nodes`. */
    requestList(dirPath: string) {
      const node = this.nodes[dirPath];

      node.loading = true;
      node.error = null;
      const requestId = generateRequestId();

      node.requestId = requestId;
      this.pendingListRequests[requestId] = dirPath;
      ipcRenderer.send('container-files/list', requestId, this.containerId, dirPath);
    },
    onListResult(_event: unknown, requestId: string, containerId: string, result: ContainerDirectoryListing) {
      if (this.isStale(containerId)) return;
      const dirPath = this.pendingListRequests[requestId];

      if (dirPath === undefined) return;
      delete this.pendingListRequests[requestId];
      const node = this.nodes[dirPath];
      const waiters = this.pendingListPromises[requestId];

      delete this.pendingListPromises[requestId];

      if (node?.requestId !== requestId) {
        waiters?.forEach(waiter =>
          waiter.reject(new Error(`Listing of ${ dirPath } was superseded by a newer request`)));

        return;
      }
      node.entries = result.entries;
      node.truncated = result.truncated;
      node.totalEntryCount = result.totalEntryCount;
      node.loading = false;
      node.error = null;
      waiters?.forEach(waiter => waiter.resolve(node));
    },
    onListError(_event: unknown, requestId: string, containerId: string, message: string) {
      if (this.isStale(containerId)) return;
      const dirPath = this.pendingListRequests[requestId];

      if (dirPath === undefined) return;
      delete this.pendingListRequests[requestId];
      const node = this.nodes[dirPath];
      const waiters = this.pendingListPromises[requestId];

      delete this.pendingListPromises[requestId];

      if (node?.requestId !== requestId) {
        waiters?.forEach(waiter =>
          waiter.reject(new Error(`Listing of ${ dirPath } was superseded by a newer request`)));

        return;
      }
      node.error = message;
      node.loading = false;
      waiters?.forEach(waiter => waiter.reject(new Error(message)));
    },
    onDiffResult(_event: unknown, containerId: string, entries: ContainerDiffEntry[]) {
      if (this.isStale(containerId)) return;
      this.diffEntries = entries;
    },
    onDiffError(_event: unknown, containerId: string, message: string) {
      if (this.isStale(containerId)) return;
      // Deliberately silent beyond a debug log: diffEntries simply stays
      // whatever it was (empty, on first open) rather than surfacing a
      // banner -- diff/mount data only ever drives small decorative badges
      // (decorate(), above), never blocks the tree itself from working, so
      // a failure here isn't worth interrupting the user over.
      console.debug('Failed to get container diff:', message);
    },
    onMountsResult(_event: unknown, containerId: string, mounts: ContainerMountInfo[]) {
      if (this.isStale(containerId)) return;
      this.mountedPaths = mounts;
    },
    onMountsError(_event: unknown, containerId: string, message: string) {
      if (this.isStale(containerId)) return;
      // See onDiffError's comment above -- same reasoning applies here.
      console.debug('Failed to get container mounts:', message);
    },
    /**
     * Expands/collapses a directory node, fetching its children the first
     * time (or after a refresh clears them).
     */
    toggleDir(dirPath: string) {
      const existing = this.nodes[dirPath];

      if (existing?.expanded) {
        existing.expanded = false;

        return;
      }

      if (existing) {
        existing.expanded = true;
      } else {
        this.nodes[dirPath] = freshNode(true);
      }

      const node = this.nodes[dirPath];

      if (node.entries === null && !node.loading) {
        this.requestList(dirPath);
      }
    },
    /**
     * Force-opens a directory node and resolves once its *current* load
     * settles -- unlike toggleDir(), never collapses an already-expanded
     * node, and returns a Promise so a caller (the search-reveal walk below)
     * can await it. Piggy-backs on an already-in-flight request for the same
     * node rather than firing a duplicate.
     */
    ensureDirLoaded(dirPath: string): Promise<TreeNode> {
      let node = this.nodes[dirPath];

      if (!node) {
        node = freshNode(false);
        this.nodes[dirPath] = node;
      }
      node.expanded = true;

      if (node.entries !== null && !node.loading) {
        return Promise.resolve(node);
      }
      // requestList() always sets node.requestId synchronously before
      // returning, so "loading ⇒ requestId is set" should always hold --
      // but re-request rather than trust that invariant unconditionally if
      // it's ever violated by a future edit, since silently keying
      // pendingListPromises on `undefined` would corrupt state rather than
      // just fail loudly.
      if (!node.loading || !node.requestId) {
        this.requestList(dirPath);
      }
      const { requestId } = node;

      if (!requestId) {
        return Promise.reject(new Error(`Failed to establish a list request for ${ dirPath }`));
      }

      return new Promise((resolve, reject) => {
        (this.pendingListPromises[requestId] ??= []).push({ resolve, reject });
      });
    },
    /**
     * Re-fetches diff/mounts, plus every node that's currently expanded (not
     * just the root), preserving expand state.
     */
    refresh() {
      ipcRenderer.send('container-files/diff', this.containerId);
      ipcRenderer.send('container-files/mounts', this.containerId);
      for (const [dirPath, node] of Object.entries(this.nodes)) {
        if (node.expanded) {
          this.requestList(dirPath);
        }
      }
    },
    decorate(entry: ContainerDirectoryEntry) {
      const mountInfo = this.mountsByPath[entry.path] ?? null;

      return {
        // A mount point's merged view always differs from the image's own
        // layers, so `diff` reports it as added/changed alongside "Mounted"
        // -- but that's not meaningful to show the user (Docker Desktop
        // shows only "Mounted" for a mount point too), so suppress it here.
        diffStatus: mountInfo ? null : (this.diffByPath[entry.path] ?? null),
        mountInfo,
      };
    },
    selectFile(entry: ContainerDirectoryEntry) {
      if (entry.kind === 'symlink' && entry.symlinkEscapesRoot) return;
      this.selectedPath = entry.path;
      this.previewLoading = true;
      this.previewError = null;
      this.preview = null;
      this.downloadMessage = null;
      const requestId = generateRequestId();

      this.previewRequestId = requestId;
      ipcRenderer.send('container-files/preview', requestId, this.containerId, entry.path);
    },
    onPreviewResult(_event: unknown, requestId: string, containerId: string, result: ContainerFilePreview) {
      if (this.isStalePreview(containerId, requestId)) return;
      this.preview = result;
      this.previewLoading = false;
    },
    onPreviewError(_event: unknown, requestId: string, containerId: string, message: string) {
      if (this.isStalePreview(containerId, requestId)) return;
      this.previewError = message;
      this.previewLoading = false;
    },
    closePreview() {
      this.selectedPath = null;
      this.preview = null;
      this.previewError = null;
      this.previewLoading = false;
      this.downloadMessage = null;
    },
    downloadFile(filePath: string) {
      this.downloadMessage = null;
      ipcRenderer.send('container-files/download', this.containerId, filePath);
    },
    /**
     * The right-click/keyboard context menu's action set for one row --
     * follows the same `availableActions` + bound-method-per-action shape
     * Images.vue/Containers.vue already use for their own ActionMenu-driven
     * row menus, so ActionMenu.vue and the `action-menu` store need no
     * per-feature special-casing. A future delete/edit action is just
     * another entry appended to this array plus another bound method here --
     * no other file needs to change again for that.
     */
    menuResourceFor(entry: ContainerDirectoryEntry): Record<string, unknown> {
      return {
        availableActions: [
          {
            label:   this.t('containerFiles.contextMenu.copyRelativePath'),
            action:  'copyRelativePath',
            enabled: true,
            icon:    'icon icon-copy',
          },
          {
            label:   this.t('containerFiles.contextMenu.download'),
            action:  'downloadEntry',
            enabled: isDownloadableEntry(entry),
            icon:    'icon icon-download',
          },
        ],
        copyRelativePath: () => this.copyRelativePath(entry.path),
        downloadEntry:    () => this.downloadEntryFromMenu(entry),
      };
    },
    onRowFocus(path: string) {
      this.focusedPath = path;
    },
    onRowBlur(path: string) {
      // Guard on a match rather than unconditionally clearing: harmless in
      // the normal case (a blur is always immediately followed by the next
      // row's own focus, if any), but avoids a newer row's focus being
      // clobbered by an out-of-order/stale blur from an older one.
      if (this.focusedPath === path) {
        this.focusedPath = null;
      }
    },
    onMenuOpen(path: string) {
      this.menuOpenPath = path;
    },
    copyRelativePath(path: string) {
      clipboard.writeText(relativeContainerPath(path));
    },
    /**
     * Downloads a file from the context menu, even when it isn't the one
     * currently open in the preview pane -- selectFile() first so
     * selectedPath matches, since onDownloadDone/onDownloadError's staleness
     * check (isStaleSelection) is keyed on selectedPath and would otherwise
     * silently drop this download's success/error feedback.
     */
    downloadEntryFromMenu(entry: ContainerDirectoryEntry) {
      this.selectFile(entry);
      this.downloadFile(entry.path);
    },
    onDownloadDone(_event: unknown, containerId: string, filePath: string, hostPath: string) {
      if (this.isStaleSelection(containerId, filePath)) return;
      this.downloadMessage = this.t('containerFiles.downloadDone', { path: hostPath });
    },
    onDownloadError(_event: unknown, containerId: string, filePath: string, message: string) {
      if (this.isStaleSelection(containerId, filePath)) return;
      this.downloadMessage = this.t('containerFiles.downloadError', { error: message });
    },
    // Exposed as a method (rather than only via treeContext, like
    // getFileIcon/diffBadgeColor/formatDate) because this component's own
    // template also calls it directly for the "too large to preview" banner.
    formatSize,
  },
});
</script>

<style lang="scss" scoped>
.container-files-component {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  overflow: hidden;
  min-height: 0;
  height: 100%;

  // Single source of truth for the size/modified/permissions column widths,
  // shared (via plain CSS variable inheritance, which crosses `scoped`
  // style boundaries even though selectors don't) with ContainerFileTreeNode
  // .vue's .tree-meta, so the header below and every row at every depth
  // agree on where each column sits.  Sized for 0.875rem monospace content
  // (these are plain `rem`, so they don't auto-scale with the local
  // 0.875rem font-size the way `ch`/`em` would -- widened by the same
  // ~7.7% the column font-size grew by (0.8125rem -> 0.875rem), plus a
  // little extra margin on --col-modified-width since a full localized
  // date/time string was already close to the old width's limit.
  --col-size-width:        5rem;
  --col-modified-width:    12rem;
  --col-permissions-width: 7rem;
}

.content-state {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2.5rem;
  flex: 1;
}

.files-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;

  .state-indicator {
    margin-right: auto;
    // Same rendered size as the state pill on the containers listing
    // (pages/Containers.vue's badge-state, which gets `.85em` from
    // `.sortable-table td .badge-state` against that table's unmodified
    // 14px/1rem ambient text size).
    font-size: 0.85rem;
  }
}

.file-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  // A coarse visual floor for the same edge case paneBounds()' JS clamp
  // handles during an actual drag/keypress (e.g. a window resize while a
  // large explicit preview-pane height is still set) -- deliberately just a
  // small fixed px value, not the real MIN_TREE_HEIGHT_FRACTION (20%) floor
  // itself: a CSS percentage min-height here would resolve against this
  // component's own total height (including the header/banners above these
  // two panes), not the space actually shared between the tree and preview
  // panes, so it wouldn't match what the JS clamp is actually enforcing.
  min-height: 60px;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  overflow: hidden;
}

// Sits between .file-panel and .preview-pane, only rendered while the
// preview pane is open -- a WAI-ARIA "separator" widget, not a native form
// control, so its own focus/hover treatment is hand-rolled here to match
// this feature's established focus-outline convention (ContainerFileTreeNode
// .vue's tree rows).
.resize-handle {
  flex-shrink: 0;
  height: 8px;
  margin: -4px 0;
  cursor: row-resize;
  position: relative;
  z-index: 1;

  &::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 50%;
    width: 32px;
    height: 2px;
    background: var(--border);
    border-radius: 1px;
    transform: translateX(-50%);
  }

  &:hover::after,
  &:focus-visible::after {
    background: var(--primary);
  }

  &:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }
}

// While actively dragging the handle, the pointer may move over the tree,
// the preview text, or outside the component entirely -- suppressing text
// selection here (rather than only on .resize-handle, which the pointer
// isn't over for most of the drag) keeps a fast drag from also selecting
// whatever content it passes over.
.resizing {
  user-select: none;
  cursor: row-resize;
}

// Sits above the scrolling .file-tree, outside its overflow:auto area, so
// it never scrolls out of view -- a plain "fixed" header, no sticky-position
// trickery needed.
.tree-header {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem 0.5rem 0.25rem;
  background: var(--nav-bg);
  border-bottom: 1px solid var(--border);
  // Matches SortableTable's own `th` styling (normal weight, body-text
  // color, no smaller font-size override) so this header reads the same
  // as the volumes/images/containers table headers.
  font-size: 0.875rem;
  font-weight: normal;
  color: var(--body-text);
  flex-shrink: 0;
}

.tree-header-primary {
  flex: 1;
  min-width: 0;
}

.tree-header-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-shrink: 0;

  .meta-size {
    width: var(--col-size-width);
    text-align: right;
  }

  .meta-modified {
    width: var(--col-modified-width);
    text-align: right;
  }

  .meta-permissions {
    width: var(--col-permissions-width);
    text-align: right;
  }
}

.file-tree {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: auto;
  scrollbar-gutter: stable;
  min-height: 0;
  padding: 0.375rem 0;
}

.preview-pane {
  flex-shrink: 0;
  // Only the *default* (unresized) ceiling -- once previewPaneHeight is set,
  // the template overrides this to `none` via inline style so the explicit
  // height (already bounded by paneBounds().max, the real available-space
  // limit) actually governs. Left in place unconditionally, this static 40%
  // would silently cap every resize at 40% regardless of what height gets
  // set -- a real bug found and fixed after this looked like it was doing
  // nothing.
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  overflow: hidden;
  // A visual floor complementing paneBounds()'s own MIN_PANE_HEIGHT JS clamp
  // -- see .file-panel's own min-height comment above.
  min-height: 120px;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--nav-bg);
  border-bottom: 1px solid var(--border);
  font-family: monospace;
  font-size: 0.875rem;
}

.preview-content {
  margin: 0;
  padding: 0.75rem;
  overflow: auto;
  font-family: monospace;
  font-size: 0.8125rem;
  white-space: pre-wrap;
  word-break: break-all;
}

.download-btn {
  margin-left: 0.75rem;
}

.download-message {
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  // --body-text: reports where the file was saved (or why it failed) --
  // meaningful status text, not a decorative annotation.
  color: var(--body-text);
}
</style>
