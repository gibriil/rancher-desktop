<template>
  <div class="container-files-component">
    <banner
      v-if="capabilities && !capabilities.supported"
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
        <button
          class="btn btn-sm role-tertiary refresh-btn"
          :disabled="anyLoading"
          data-testid="files-refresh"
          @click="refresh"
        >
          <i :class="anyLoading ? 'icon icon-spinner icon-spin' : 'icon icon-refresh'" />
        </button>
      </div>

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

      <div
        v-else
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
          data-testid="file-tree"
        >
          <container-file-tree-node
            path="/"
            :depth="0"
            :context="treeContext"
          />
        </div>
      </div>

      <div
        v-if="selectedPath"
        class="preview-pane"
        data-testid="file-preview"
      >
        <div class="preview-header">
          <span class="preview-path">{{ selectedPath }}</span>
          <button
            class="btn btn-sm role-tertiary"
            data-testid="preview-close"
            @click="closePreview"
          >
            <i class="icon icon-close" />
          </button>
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
            <span>{{ preview.kind === 'too-large' ? t('containerFiles.tooLarge', { size: formatSize(preview.totalSize) }) : t('containerFiles.binaryFile') }}</span>
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
  </div>
</template>

<script lang="ts">
import { BadgeState, Banner } from '@rancher/components';
import { defineComponent } from 'vue';

import type {
  ContainerDiffEntry, ContainerDirectoryEntry, ContainerFilePreview, ContainerFilesCapabilities, ContainerMountInfo,
} from '@pkg/backend/containerClient/fileTypes';
import ContainerFileTreeNode from '@pkg/components/ContainerFileTreeNode.vue';
import LoadingIndicator from '@pkg/components/LoadingIndicator.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * A locally-unique ID to correlate an IPC request with its response -- no
 * cryptographic strength needed, so this deliberately avoids
 * `crypto.randomUUID()`, which isn't reliably present on the `crypto`
 * global across all Electron/Chromium builds this app runs on.
 */
function generateRequestId(): string {
  return `${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2) }`;
}

/**
 * One directory's worth of state.  Keyed by absolute path in `nodes` below --
 * a flat map instead of a nested structure so any node can be looked up,
 * created, or updated in O(1) regardless of how deep it is, and so several
 * nodes can be independently loading/expanded/truncated at once (a tree, as
 * opposed to the single "current directory" the old breadcrumb browser had).
 */
interface TreeNode {
  entries:         ContainerDirectoryEntry[] | null; // null = never fetched
  expanded:        boolean;
  loading:         boolean;
  error:           string | null;
  truncated:       boolean;
  totalEntryCount: number | null;
  requestId:       string | null; // the list request this node is currently waiting on, if any
}

function freshNode(expanded: boolean): TreeNode {
  return {
    entries: null, expanded, loading: false, error: null, truncated: false, totalEntryCount: null, requestId: null,
  };
}

interface Data {
  capabilities:        ContainerFilesCapabilities | null;
  nodes:               Record<string, TreeNode>;
  pendingListRequests: Record<string, string>; // requestId -> path
  diffEntries:         ContainerDiffEntry[];
  mountedPaths:        ContainerMountInfo[];
  selectedPath:        string | null;
  preview:             ContainerFilePreview | null;
  previewLoading:      boolean;
  previewError:        string | null;
  downloadMessage:     string | null;
  previewRequestId:    string | null;
}

export default defineComponent({
  name:       'container-files',
  components: {
    BadgeState,
    Banner,
    ContainerFileTreeNode,
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
      nodes:               { '/': freshNode(true) },
      pendingListRequests: {},
      diffEntries:         [],
      mountedPaths:        [],
      selectedPath:        null,
      preview:             null,
      previewLoading:      false,
      previewError:        null,
      downloadMessage:     null,
      previewRequestId:    null,
    };
  },
  computed: {
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
    treeContext() {
      return {
        nodes:          this.nodes,
        decorate:       this.decorate,
        onToggleDir:    this.toggleDir,
        onSelectFile:   this.selectFile,
        formatSize:     this.formatSize,
        formatDate:     this.formatDate,
        getFileIcon:    this.getFileIcon,
        diffBadgeColor: this.diffBadgeColor,
        // `t` is a global property (installed by the i18n plugin), not a
        // component method, so Vue doesn't auto-bind it to `this` the way
        // it does everything else above -- wrap it or lose `this.$store`
        // once it's called as `context.t(...)` instead of `this.t(...)`.
        t:              (key: string, args?: Record<string, unknown>) => this.t(key, args),
      };
    },
  },
  watch: {
    containerId() {
      this.resetAndOpen();
    },
  },
  mounted() {
    ipcRenderer.on('container-files/capabilities', this.onCapabilities);
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
      this.pendingListRequests = {};
      this.nodes = { '/': freshNode(true) };
      this.diffEntries = [];
      this.mountedPaths = [];
      this.closePreview();
      this.openSession();
    },
    openSession() {
      ipcRenderer.send('container-files/open', this.containerId, this.namespace);
      ipcRenderer.send('container-files/diff', this.containerId);
      ipcRenderer.send('container-files/mounts', this.containerId);
      this.requestList('/');
    },
    onCapabilities(_event: unknown, containerId: string, result: ContainerFilesCapabilities) {
      if (containerId !== this.containerId) return;
      this.capabilities = result;
    },
    onStopped(_event: unknown, containerId: string) {
      if (containerId !== this.containerId) return;
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
    onListResult(_event: unknown, requestId: string, containerId: string, result: { path: string, entries: ContainerDirectoryEntry[], truncated: boolean, totalEntryCount: number | null }) {
      if (containerId !== this.containerId) return;
      const dirPath = this.pendingListRequests[requestId];

      if (dirPath === undefined) return;
      delete this.pendingListRequests[requestId];
      const node = this.nodes[dirPath];

      if (node?.requestId !== requestId) return;
      node.entries = result.entries;
      node.truncated = result.truncated;
      node.totalEntryCount = result.totalEntryCount;
      node.loading = false;
      node.error = null;
    },
    onListError(_event: unknown, requestId: string, containerId: string, message: string) {
      if (containerId !== this.containerId) return;
      const dirPath = this.pendingListRequests[requestId];

      if (dirPath === undefined) return;
      delete this.pendingListRequests[requestId];
      const node = this.nodes[dirPath];

      if (node?.requestId !== requestId) return;
      node.error = message;
      node.loading = false;
    },
    onDiffResult(_event: unknown, containerId: string, entries: ContainerDiffEntry[]) {
      if (containerId !== this.containerId) return;
      this.diffEntries = entries;
    },
    onDiffError(_event: unknown, containerId: string, message: string) {
      if (containerId !== this.containerId) return;
      console.debug('Failed to get container diff:', message);
    },
    onMountsResult(_event: unknown, containerId: string, mounts: ContainerMountInfo[]) {
      if (containerId !== this.containerId) return;
      this.mountedPaths = mounts;
    },
    onMountsError(_event: unknown, containerId: string, message: string) {
      if (containerId !== this.containerId) return;
      console.debug('Failed to get container mounts:', message);
    },
    /** Expands/collapses a directory node, fetching its children the first time (or after a refresh clears them). */
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
    /** Re-fetches diff/mounts, plus every node that's currently expanded (not just the root), preserving expand state. */
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
      return {
        diffStatus: this.diffByPath[entry.path] ?? null,
        mountInfo:  this.mountsByPath[entry.path] ?? null,
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
      if (containerId !== this.containerId || requestId !== this.previewRequestId) return;
      this.preview = result;
      this.previewLoading = false;
    },
    onPreviewError(_event: unknown, requestId: string, containerId: string, message: string) {
      if (containerId !== this.containerId || requestId !== this.previewRequestId) return;
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
    onDownloadDone(_event: unknown, containerId: string, filePath: string, hostPath: string) {
      if (containerId !== this.containerId || filePath !== this.selectedPath) return;
      this.downloadMessage = this.t('containerFiles.downloadDone', { path: hostPath });
    },
    onDownloadError(_event: unknown, containerId: string, filePath: string, message: string) {
      if (containerId !== this.containerId || filePath !== this.selectedPath) return;
      this.downloadMessage = this.t('containerFiles.downloadError', { error: message });
    },
    getFileIcon(entry: ContainerDirectoryEntry): string {
      if (entry.kind === 'directory') return 'icon icon-folder';
      if (entry.kind === 'symlink') return 'icon icon-external-link';

      return 'icon icon-file';
    },
    diffBadgeColor(status: ContainerDiffEntry['status']): string {
      switch (status) {
      case 'added': return 'bg-success';
      case 'changed': return 'bg-warning';
      default: return 'bg-darker';
      }
    },
    formatSize(bytes: number | null): string {
      if (bytes === null) return '?';
      if (bytes === 0) return '0 B';
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));

      return `${ Math.round((bytes / Math.pow(1024, i)) * 100) / 100 } ${ sizes[i] }`;
    },
    formatDate(mtime: string | null): string {
      return mtime ? new Date(mtime).toLocaleString() : '?';
    },
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
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  overflow: hidden;
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
  overflow: auto;
  scrollbar-gutter: stable;
  min-height: 0;
  padding: 0.375rem 0;
}

.preview-pane {
  flex-shrink: 0;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  overflow: hidden;
  min-height: 0;
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
