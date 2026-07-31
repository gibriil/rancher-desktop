<template>
  <div
    class="tree-node"
    role="group"
  >
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
        v-if="node.entries.length === 0 && !context.filterTerm"
        class="tree-empty"
      >
        {{ context.t('containerFiles.noFiles') }}
      </div>

      <template
        v-for="entry in filteredEntries"
        :key="entry.path"
      >
        <div
          class="tree-row"
          :class="{ 'is-inert': isInert(entry), 'is-search-current': context.highlightedMatchPath === entry.path }"
          :data-tree-row-path="entry.path"
          :data-row-focus="isFocused(entry)"
          :data-tree-row-menu-open="isMenuOpen(entry)"
          role="treeitem"
          tabindex="0"
          :aria-expanded="entry.kind === 'directory' ? isExpanded(entry.path) : undefined"
          @keydown="onRowKeydown($event, entry)"
          @contextmenu="onRowContextMenu($event, entry)"
          @focus="context.onRowFocus(entry.path)"
          @blur="context.onRowBlur(entry.path)"
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
              >
                <span
                  v-for="(segment, i) in context.highlightSegments(entry.name, context.filterTerm)"
                  :key="i"
                  :class="{ 'is-match': segment.matched }"
                >{{ segment.text }}</span>
              </span>
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
import { defineComponent, PropType } from 'vue';

import type { ContainerDirectoryEntry } from '@pkg/backend/containerClient/fileTypes';
import type { TreeContext } from '@pkg/components/ContainerFiles.vue';
import { isInertEntry } from '@pkg/components/containerFilesHelpers';
import LoadingIndicator from '@pkg/components/LoadingIndicator.vue';
import { suppressContextMenu } from '@pkg/utils/platform';

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
      type:     Object as PropType<TreeContext>,
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
    /**
     * Rows actually shown at this level: everything, unless a local filter
     * term is active, in which case only entries whose own name matches, or
     * directories whose already-loaded subtree contains a match somewhere
     * (context.subtreeHasMatch) -- a directory never opened isn't searched.
     */
    filteredEntries(): ContainerDirectoryEntry[] {
      const term = this.context.filterTerm;

      if (!term) {
        return this.sortedEntries;
      }

      return this.sortedEntries.filter(entry => entry.name.toLowerCase().includes(term) ||
        (entry.kind === 'directory' && this.context.subtreeHasMatch(entry.path, term)));
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
      return isInertEntry(entry);
    },
    rowTitle(entry: ContainerDirectoryEntry): string | undefined {
      return this.isInert(entry) ? this.context.t('containerFiles.symlinkEscapesRoot') : undefined;
    },
    /**
     * Drives the row's focus outline together with isMenuOpen() below,
     * rather than :focus-visible alone -- opening this row's context menu
     * moves real DOM focus onto a menu item, which would otherwise make the
     * row look unfocused for as long as its own menu is open.
     */
    isFocused(entry: ContainerDirectoryEntry): boolean {
      return this.context.focusedPath === entry.path;
    },
    isMenuOpen(entry: ContainerDirectoryEntry): boolean {
      return this.context.menuOpenPath === entry.path;
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
    /**
     * Opens the row's context menu at the click point, reusing the same
     * global ActionMenu/action-menu-store mechanism SortableTable's own
     * per-row right-click menu already relies on (selection.js's
     * onRowContext) -- including respecting the same Ctrl-click convention
     * so the native macOS context menu still comes through untouched.
     */
    onRowContextMenu(event: MouseEvent, entry: ContainerDirectoryEntry) {
      if (suppressContextMenu(event)) return;
      event.preventDefault();
      // Explicitly focus the row -- a right-click doesn't reliably move
      // focus to it the way a left-click does, which left the row without
      // its focus-visible outline and, separately, meant the menu had
      // nothing correct to restore focus to once it closed.
      (event.currentTarget as HTMLElement).focus();
      this.context.onMenuOpen(entry.path);
      this.$store.commit('action-menu/show', {
        resources: [this.context.menuResourceFor(entry)],
        event,
      });
    },
    /**
     * Keyboard equivalent of the row's mouse interactions -- expand/collapse
     * and file-open were previously mouse-only (@click on the chevron/label
     * spans), which left the tree's core interaction entirely unreachable
     * without a pointer. Enter/Space mirror onRowClick(); arrow-right/left
     * expand/collapse a directory row directly; arrow-up/down move focus
     * between visible rows; the ContextMenu key or Shift+F10 (the standard
     * OS conventions) open the same context menu a right-click does,
     * anchored to the name label rather than a click point.
     */
    onRowKeydown(event: KeyboardEvent, entry: ContainerDirectoryEntry) {
      switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.onRowClick(entry);
        break;
      case 'ContextMenu':
      case 'F10':
        if (event.key === 'F10' && !event.shiftKey) break;
        event.preventDefault();
        this.context.onMenuOpen(entry.path);
        this.$store.commit('action-menu/show', {
          resources: [this.context.menuResourceFor(entry)],
          // Anchored to the name label itself -- ActionMenu.vue positions a
          // keyboard-opened (elem-anchored) menu flush over its trigger, so
          // this lands the menu right at the name, same as a native
          // dropdown hanging from what opened it.
          elem: (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.tree-label') ?? event.currentTarget as HTMLElement,
        });
        break;
      case 'ArrowRight':
        if (entry.kind === 'directory' && !this.isInert(entry) && !this.isExpanded(entry.path)) {
          event.preventDefault();
          this.context.onToggleDir(entry.path);
        }
        break;
      case 'ArrowLeft':
        if (entry.kind === 'directory' && this.isExpanded(entry.path)) {
          event.preventDefault();
          this.context.onToggleDir(entry.path);
        }
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.focusAdjacentRow(event.currentTarget as HTMLElement, 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.focusAdjacentRow(event.currentTarget as HTMLElement, -1);
        break;
      }
    },
    /**
     * Moves focus to the next/previous visible tree row, in document order.
     * Queried live via the DOM -- the same data-tree-row-path convention
     * ContainerFiles.vue's own search-reveal scrollToRow() already uses --
     * rather than through a ref registry, since rows come and go across an
     * arbitrarily deep, recursively-rendered tree with no single component
     * that owns all of them.
     */
    focusAdjacentRow(current: HTMLElement, direction: 1 | -1) {
      const rows = Array.from(current.ownerDocument.querySelectorAll<HTMLElement>('.tree-row[role="treeitem"]'));
      const index = rows.indexOf(current);

      if (index === -1) return;
      rows[index + direction]?.focus();
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

  // :focus-visible alone isn't enough: opening this row's context menu
  // moves real DOM focus onto a menu item (see isFocused()/isMenuOpen()
  // above), which would otherwise drop the outline for as long as the menu
  // stays open even though the row is still what the user is "on."
  &:focus-visible,
  &[data-row-focus="true"] {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }

  // Softer/dashed rather than the solid focus outline above -- this row
  // isn't itself focused right now (focus is on the menu), so the outline
  // should read as "this row owns the open menu," not as an identical
  // stand-in for real focus. Declared after the rule above so it wins on
  // the brief overlap where a row is still focused right as its menu opens.
  &[data-tree-row-menu-open="true"] {
    outline: 1px dashed var(--primary);
    outline-offset: -2px;
  }

  &.is-inert {
    opacity: 0.6;
  }

  // The row a full-search reveal walk just scrolled to and highlighted --
  // distinct from .is-match below (the instant local filter's inline
  // substring highlight), since the two mechanisms answer different
  // questions ("where did my search land" vs. "what matched my filter").
  &.is-search-current {
    background: var(--nav-bg);
    outline: 1px solid var(--primary);
    outline-offset: -1px;
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

  // --logs-highlight(-bg) are existing theme tokens (both themes) evidently
  // intended for exactly this "highlight a search match" purpose, though not
  // otherwise consumed anywhere yet -- reusing them here rather than
  // inventing a new one-off color.
  .is-match {
    background: var(--logs-highlight-bg);
    color: var(--logs-highlight);
    border-radius: 2px;
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
