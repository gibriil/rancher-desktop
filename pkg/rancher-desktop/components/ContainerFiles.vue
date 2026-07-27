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
      <div class="path-breadcrumb">
        <span
          class="breadcrumb-item"
          :class="{ 'is-current': pathSegments.length === 0 }"
          data-testid="breadcrumb-root"
          @click="navigateToPath('/')"
        >
          <i class="icon icon-folder-open" />root
        </span>
        <template
          v-for="(segment, index) in pathSegments"
          :key="`path-${index}`"
        >
          <span class="breadcrumb-separator">/</span>
          <span
            class="breadcrumb-item"
            :class="{ 'is-current': index === pathSegments.length - 1 }"
            @click="index < pathSegments.length - 1 ? navigateToPath(getPathUpTo(index)) : null"
          >
            {{ segment }}
          </span>
        </template>
        <badge-state
          v-if="!isContainerRunning"
          color="bg-darker"
          :label="t('containerFiles.stoppedIndicator')"
          class="stopped-indicator"
          data-testid="files-stopped-indicator"
        />
        <button
          class="btn btn-sm role-tertiary refresh-btn"
          :disabled="loading"
          data-testid="files-refresh"
          @click="refresh"
        >
          <i class="icon icon-refresh" />
        </button>
      </div>

      <banner
        v-if="truncated"
        class="content-banner"
        color="info"
        data-testid="files-truncated"
      >
        {{ t('containerFiles.truncated', { shown: entries.length, total: totalEntryCount }) }}
      </banner>

      <loading-indicator
        v-if="loading"
        class="content-state"
      >
        {{ t('containerFiles.loading') }}
      </loading-indicator>

      <banner
        v-else-if="listError"
        class="content-state"
        color="error"
        data-testid="files-error"
      >
        <span class="icon icon-info-circle icon-lg" />
        {{ listError }}
      </banner>

      <div
        v-else
        class="file-browser"
      >
        <sortable-table
          :headers="headers"
          :paging="false"
          :row-actions="false"
          :rows="rows"
          :search="false"
          :table-actions="false"
          class="files-table"
          key-field="path"
          no-rows-key="containerFiles.noFiles"
        >
          <template #col:name="{ row }">
            <td>
              <span
                :class="{ 'is-directory': row.kind === 'directory', 'is-clickable': row.kind !== 'other' }"
                class="file-name"
                @click="onRowClick(row)"
              >
                <i
                  :class="getFileIcon(row)"
                  class="file-icon"
                />
                {{ row.name }}
                <badge-state
                  v-if="row.diffStatus"
                  :color="diffBadgeColor(row.diffStatus)"
                  :label="t(`containerFiles.diff.${row.diffStatus}`)"
                  class="file-badge"
                />
                <badge-state
                  v-if="row.mountInfo"
                  color="bg-info"
                  :label="t('containerFiles.mounted')"
                  class="file-badge"
                />
              </span>
            </td>
          </template>
          <template #col:size="{ row }">
            <td>{{ row.kind === 'directory' ? '-' : formatSize(row.size) }}</td>
          </template>
          <template #col:modified="{ row }">
            <td>{{ formatDate(row.mtime) }}</td>
          </template>
          <template #col:permissions="{ row }">
            <td class="permissions">
              {{ row.mode }}
            </td>
          </template>
        </sortable-table>
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
            <i class="icon icon-x" />
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
import LoadingIndicator from '@pkg/components/LoadingIndicator.vue';
import SortableTable from '@pkg/components/SortableTable';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface FileRow extends ContainerDirectoryEntry {
  diffStatus: ContainerDiffEntry['status'] | null;
  mountInfo:  ContainerMountInfo | null;
}

/**
 * A locally-unique ID to correlate an IPC request with its response -- no
 * cryptographic strength needed, so this deliberately avoids
 * `crypto.randomUUID()`, which isn't reliably present on the `crypto`
 * global across all Electron/Chromium builds this app runs on.
 */
function generateRequestId(): string {
  return `${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2) }`;
}

interface Data {
  capabilities:     ContainerFilesCapabilities | null;
  currentPath:      string;
  entries:          ContainerDirectoryEntry[];
  loading:          boolean;
  listError:        string | null;
  truncated:        boolean;
  totalEntryCount:  number | null;
  diffEntries:      ContainerDiffEntry[];
  mountedPaths:     ContainerMountInfo[];
  selectedPath:     string | null;
  preview:          ContainerFilePreview | null;
  previewLoading:   boolean;
  previewError:     string | null;
  downloadMessage:  string | null;
  listRequestId:    string | null;
  previewRequestId: string | null;
}

export default defineComponent({
  name:       'container-files',
  components: {
    BadgeState,
    Banner,
    LoadingIndicator,
    SortableTable,
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
    namespace: {
      type:    String,
      default: undefined,
    },
  },
  data(): Data {
    return {
      capabilities:     null,
      currentPath:      '/',
      entries:          [],
      loading:          true,
      listError:        null,
      truncated:        false,
      totalEntryCount:  null,
      diffEntries:      [],
      mountedPaths:     [],
      selectedPath:     null,
      preview:          null,
      previewLoading:   false,
      previewError:     null,
      downloadMessage:  null,
      listRequestId:    null,
      previewRequestId: null,
    };
  },
  computed: {
    headers() {
      return [
        {
          name:  'name',
          label: this.t('containerFiles.table.header.name'),
          sort:  ['name'],
        },
        {
          name:  'size',
          label: this.t('containerFiles.table.header.size'),
          sort:  ['size', 'name'],
          width: 100,
        },
        {
          name:  'modified',
          label: this.t('containerFiles.table.header.modified'),
          sort:  ['mtime', 'name'],
          width: 180,
        },
        {
          name:  'permissions',
          label: this.t('containerFiles.table.header.permissions'),
          sort:  ['mode', 'name'],
          width: 120,
        },
      ];
    },
    pathSegments(): string[] {
      return this.currentPath.split('/').filter(segment => segment !== '');
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
    rows(): FileRow[] {
      const sorted = [...this.entries].sort((a, b) => {
        if ((a.kind === 'directory') !== (b.kind === 'directory')) {
          return a.kind === 'directory' ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      });

      return sorted.map(entry => ({
        ...entry,
        diffStatus: this.diffByPath[entry.path] ?? null,
        mountInfo:  this.mountsByPath[entry.path] ?? null,
      }));
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
      this.currentPath = '/';
      this.entries = [];
      this.listError = null;
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
      this.listError = this.t('containerFiles.sessionStopped');
      this.loading = false;
    },
    requestList(dirPath: string) {
      this.loading = true;
      this.listError = null;
      this.currentPath = dirPath;
      const requestId = generateRequestId();

      this.listRequestId = requestId;
      ipcRenderer.send('container-files/list', requestId, this.containerId, dirPath);
    },
    onListResult(_event: unknown, requestId: string, containerId: string, result: { path: string, entries: ContainerDirectoryEntry[], truncated: boolean, totalEntryCount: number | null }) {
      if (containerId !== this.containerId || requestId !== this.listRequestId) return;
      this.entries = result.entries;
      this.truncated = result.truncated;
      this.totalEntryCount = result.totalEntryCount;
      this.loading = false;
    },
    onListError(_event: unknown, requestId: string, containerId: string, message: string) {
      if (containerId !== this.containerId || requestId !== this.listRequestId) return;
      this.listError = message;
      this.loading = false;
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
    navigateToPath(dirPath: string) {
      if (this.currentPath === dirPath) return;
      this.closePreview();
      this.requestList(dirPath);
    },
    getPathUpTo(index: number): string {
      return `/${ this.pathSegments.slice(0, index + 1).join('/') }`;
    },
    refresh() {
      this.requestList(this.currentPath);
      ipcRenderer.send('container-files/diff', this.containerId);
      ipcRenderer.send('container-files/mounts', this.containerId);
    },
    onRowClick(row: FileRow) {
      if (row.kind === 'directory') {
        this.navigateToPath(row.path);
      } else if (row.kind === 'file' || row.kind === 'symlink') {
        this.selectFile(row);
      }
    },
    selectFile(row: FileRow) {
      this.selectedPath = row.path;
      this.previewLoading = true;
      this.previewError = null;
      this.preview = null;
      this.downloadMessage = null;
      const requestId = generateRequestId();

      this.previewRequestId = requestId;
      ipcRenderer.send('container-files/preview', requestId, this.containerId, row.path);
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
    getFileIcon(row: FileRow): string {
      if (row.kind === 'directory') return 'icon icon-folder';
      if (row.kind === 'symlink') return 'icon icon-link';

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
}

.content-state {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2.5rem;
  flex: 1;
}

.content-banner {
  margin: 0;
}

.path-breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0.625rem;
  background: var(--nav-bg);
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  font-family: monospace;
  font-size: 0.875rem;
  overflow-x: auto;

  .breadcrumb-item {
    color: var(--link);
    cursor: pointer;
    white-space: nowrap;

    &:hover:not(.is-current) {
      color: var(--link-hover);
      text-decoration: underline;
    }

    &.is-current {
      color: var(--body-text);
      cursor: default;
      font-weight: 500;
    }

    .icon {
      margin-right: 0.25rem;
    }
  }

  .breadcrumb-separator {
    color: var(--muted);
    user-select: none;
  }

  .stopped-indicator {
    margin-left: auto;
    font-size: 0.6875rem;
  }

  .refresh-btn {
    margin-left: 0.5rem;
  }
}

.file-browser {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.file-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;

  &.is-directory {
    color: var(--link);
    font-weight: 500;
  }

  &.is-clickable {
    cursor: pointer;

    &:hover {
      color: var(--link-hover);
      text-decoration: underline;
    }
  }
}

.file-icon {
  font-size: 1rem;
  color: var(--muted);

  .is-directory & {
    color: var(--warning);
  }
}

.file-badge {
  font-size: 0.6875rem;
}

.permissions {
  font-family: monospace;
  font-size: 0.875rem;
  color: var(--muted);
}

.files-table {
  flex: 1;
  overflow: auto;
  min-height: 0;
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
  font-size: 0.8125rem;
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
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
