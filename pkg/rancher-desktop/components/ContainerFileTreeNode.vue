<template>
  <div class="tree-node">
    <loading-indicator
      v-if="node && node.loading && !node.entries"
      class="tree-state"
    >
      {{ context.t('containerFiles.loading') }}
    </loading-indicator>

    <banner
      v-else-if="node && node.error"
      class="tree-state"
      color="error"
      data-testid="tree-node-error"
    >
      <span class="icon icon-info-circle icon-lg" />
      {{ node.error }}
    </banner>

    <template v-else-if="node && node.entries">
      <div
        v-if="node.entries.length === 0"
        class="tree-empty"
      >
        {{ context.t('containerFiles.noFiles') }}
      </div>

      <template
        v-for="entry in sortedEntries"
        :key="entry.path"
      >
        <div
          class="tree-row"
          :class="{ 'is-inert': isInert(entry) }"
        >
          <div
            class="tree-primary"
            :style="{ paddingLeft: `${depth * 1.25}rem` }"
          >
            <span
              class="tree-toggle"
              @click="entry.kind === 'directory' ? context.onToggleDir(entry.path) : null"
            >
              <i
                v-if="isLoading(entry.path)"
                class="icon icon-spinner icon-spin"
              />
              <i
                v-else-if="entry.kind === 'directory'"
                :class="isExpanded(entry.path) ? 'icon icon-chevron-down' : 'icon icon-chevron-right'"
              />
            </span>

            <span
              class="tree-label"
              :class="{ 'is-clickable': !isInert(entry) && entry.kind !== 'other' }"
              :title="rowTitle(entry)"
              @click="onRowClick(entry)"
            >
              <i
                :class="context.getFileIcon(entry)"
                class="tree-icon"
              />
              <span
                class="tree-name"
                :class="{ 'is-directory': entry.kind === 'directory', 'is-symlink': entry.kind === 'symlink' }"
              >{{ entry.name }}</span>
              <span
                v-if="entry.kind === 'symlink' && entry.symlinkTarget"
                class="symlink-target"
              >&rarr; {{ entry.symlinkTarget }}</span>
              <i
                v-if="entry.kind === 'symlink' && entry.symlinkEscapesRoot"
                class="icon icon-alert symlink-warning"
                :title="context.t('containerFiles.symlinkEscapesRoot')"
              />
              <badge-state
                v-if="decorated(entry).diffStatus"
                :color="context.diffBadgeColor(decorated(entry).diffStatus)"
                :label="context.t(`containerFiles.diff.${decorated(entry).diffStatus}`)"
                class="tree-badge"
              />
              <badge-state
                v-if="decorated(entry).mountInfo"
                color="bg-info"
                :label="context.t('containerFiles.mounted')"
                class="tree-badge"
              />
            </span>
          </div>

          <span class="tree-meta">
            <span class="meta-size">{{ entry.kind === 'directory' ? '-' : context.formatSize(entry.size) }}</span>
            <span class="meta-modified">{{ context.formatDate(entry.mtime) }}</span>
            <span class="meta-permissions">{{ entry.mode }}</span>
          </span>
        </div>

        <container-file-tree-node
          v-if="entry.kind === 'directory' && isExpanded(entry.path)"
          :path="entry.path"
          :depth="depth + 1"
          :context="context"
        />
      </template>

      <div
        v-if="node.truncated"
        class="tree-truncated"
      >
        {{ context.t('containerFiles.truncated', { shown: node.entries.length, total: node.totalEntryCount }) }}
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { BadgeState, Banner } from '@rancher/components';
import { defineComponent } from 'vue';

import type { ContainerDirectoryEntry } from '@pkg/backend/containerClient/fileTypes';
import LoadingIndicator from '@pkg/components/LoadingIndicator.vue';

/**
 * One directory's worth of rows in the container filesystem tree, recursing
 * into itself for expanded subdirectories.  All actual state (which nodes
 * are expanded, their loaded entries, in-flight requests) lives in the
 * `context.nodes` map owned by ContainerFiles.vue -- this component only
 * reads that map and delegates user actions back up via `context`, so a
 * single source of truth survives across however many levels are expanded.
 */
export default defineComponent({
  name:       'container-file-tree-node',
  components: {
    BadgeState,
    Banner,
    LoadingIndicator,
  },
  props: {
    path: {
      type:     String,
      required: true,
    },
    depth: {
      type:     Number,
      required: true,
    },
    context: {
      type:     Object,
      required: true,
    },
  },
  computed: {
    node() {
      return this.context.nodes[this.path];
    },
    sortedEntries(): ContainerDirectoryEntry[] {
      if (!this.node?.entries) {
        return [];
      }

      return [...this.node.entries].sort((a, b) => a.name.localeCompare(b.name));
    },
  },
  methods: {
    isExpanded(path: string): boolean {
      return this.context.nodes[path]?.expanded === true;
    },
    /** True while (re-)fetching a directory's children -- covers both the first load and a refresh of an already-loaded node. */
    isLoading(path: string): boolean {
      return this.context.nodes[path]?.loading === true;
    },
    /** A symlink escaping the container's mount is shown but never followed -- this is the feature's security boundary. */
    isInert(entry: ContainerDirectoryEntry): boolean {
      return entry.kind === 'symlink' && entry.symlinkEscapesRoot;
    },
    rowTitle(entry: ContainerDirectoryEntry): string | null {
      return this.isInert(entry) ? this.context.t('containerFiles.symlinkEscapesRoot') : null;
    },
    decorated(entry: ContainerDirectoryEntry) {
      return this.context.decorate(entry);
    },
    onRowClick(entry: ContainerDirectoryEntry) {
      if (this.isInert(entry)) return;
      if (entry.kind === 'directory') {
        this.context.onToggleDir(entry.path);
      } else if (entry.kind === 'file' || entry.kind === 'symlink') {
        this.context.onSelectFile(entry);
      }
    },
  },
});
</script>

<style lang="scss" scoped>
.tree-state {
  padding: 0.5rem 0.75rem;
}

.tree-empty {
  padding: 0.375rem 0.75rem;
  // --body-text, not --muted: this is meaningful status text ("this
  // directory is empty"), not a decorative annotation -- see the ADA
  // Title II / WCAG notes in the container-file-viewer plan doc.
  color: var(--body-text);
  // Matches the sibling volumes file-browser's own secondary text
  // (pages/volumes/files/_name.vue's .permissions/.path-breadcrumb), not
  // an arbitrary smaller size.
  font-size: 0.875rem;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem 0.25rem 0.25rem;
  border-radius: var(--border-radius);

  &:hover {
    background: var(--nav-bg);
  }

  &.is-inert {
    opacity: 0.6;
  }
}

// Only this wrapper indents with depth -- .tree-meta stays a fixed-width
// sibling so the size/modified/permissions columns line up with the header
// and with each other regardless of how deep a row is nested.
.tree-primary {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex: 1;
  min-width: 0;
}

.tree-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  flex-shrink: 0;
  cursor: pointer;
  // Decorative icon glyph, not text -- WCAG 1.4.11's 3:1 non-text
  // threshold applies here, not 1.4.3's 4.5:1 text threshold, so --muted
  // is fine for this one.
  color: var(--muted);
}

.tree-label {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  flex: 1;
  min-width: 0;
  overflow: hidden;

  &.is-clickable {
    cursor: pointer;

    &:hover .tree-name {
      color: var(--link-hover);
      text-decoration: underline;
    }
  }
}

.tree-icon {
  font-size: 1rem;
  // Decorative file-type glyph -- same non-text 3:1 exemption as .tree-toggle.
  color: var(--muted);
  flex-shrink: 0;
}

.tree-name {
  white-space: nowrap;

  &.is-directory {
    color: var(--link);
    font-weight: 500;
  }

  &.is-symlink {
    font-style: italic;
  }
}

.symlink-target {
  // --body-text: the link's actual target path, not decorative.
  color: var(--body-text);
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.symlink-warning {
  color: var(--warning);
  flex-shrink: 0;
}

.tree-badge {
  // 0.85rem, not an arbitrary smaller size -- this is the same size the
  // "Exited"-style state pill renders at on the containers listing
  // (BadgeState gets `font-size: .85em` inside a `.sortable-table td`,
  // and that table's own ambient text size is the unmodified 14px/1rem
  // global body default, so .85em there == 0.85rem here).
  font-size: 0.85rem;
  flex-shrink: 0;
}

// Column widths come from CSS variables set once on .container-files-component
// (ContainerFiles.vue) so this component's rows and that component's header
// row always agree on where each column sits, with a literal fallback here
// in case this ever renders without that ancestor.
.tree-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-shrink: 0;
  font-family: monospace;
  // Matches the volumes file-browser's .permissions text size.
  font-size: 0.875rem;
  // Full body-text contrast, not --muted -- this is primary file
  // information (size/modified/permissions), not a secondary annotation,
  // and --muted's contrast ratio against --body-bg fails WCAG 2.0 AA in
  // both themes (measured ~2:1 light / ~3.3:1 dark, need 4.5:1).
  color: var(--body-text);

  .meta-size {
    width: var(--col-size-width, 5rem);
    text-align: right;
  }

  .meta-modified {
    width: var(--col-modified-width, 12rem);
    text-align: right;
  }

  .meta-permissions {
    width: var(--col-permissions-width, 7rem);
    text-align: right;
  }
}

.tree-truncated {
  padding: 0.25rem 0.625rem;
  // --body-text: the shown/total count is meaningful, not decorative.
  color: var(--body-text);
  font-size: 0.875rem;
}
</style>
