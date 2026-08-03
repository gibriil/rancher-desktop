<template>
  <div
    class="file-search-widget"
    data-testid="files-search-widget"
  >
    <input
      ref="searchInput"
      v-model="localValue"
      :aria-label="t('containerFiles.search.ariaLabel')"
      class="search-input"
      data-testid="files-search-input"
      :placeholder="t('containerFiles.search.placeholder')"
      type="search"
      @keydown.enter="$emit('search')"
    >

    <i
      v-if="status === 'searching'"
      aria-hidden="true"
      class="icon icon-spinner icon-spin search-status-icon"
    />

    <template v-else-if="matchCount > 0">
      <template v-if="revealedCount < matchCount">
        <i
          aria-hidden="true"
          class="icon icon-spinner icon-spin search-status-icon"
        />
        <span
          class="match-count"
          data-testid="files-search-count"
        >{{ t('containerFiles.search.revealingCount', { revealed: revealedCount, total: matchCount }) }}</span>
      </template>
      <template v-else>
        <span
          class="match-count"
          data-testid="files-search-count"
        >{{ t('containerFiles.search.resultCount', { current: currentIndex + 1, total: matchCount }) }}</span>
        <icon-button
          class="search-btn btn role-tertiary"
          icon="icon icon-chevron-up"
          :disabled="matchCount < 2"
          :aria-label="t('containerFiles.search.previousMatch')"
          test-id="files-search-prev-btn"
          @click="$emit('previous')"
        />
        <icon-button
          class="search-btn btn role-tertiary"
          icon="icon icon-chevron-down"
          :disabled="matchCount < 2"
          :aria-label="t('containerFiles.search.nextMatch')"
          test-id="files-search-next-btn"
          @click="$emit('next')"
        />
      </template>
    </template>

    <icon-button
      class="search-btn btn role-tertiary"
      icon="icon icon-search"
      :disabled="!modelValue"
      :aria-label="t('containerFiles.search.searchAll')"
      test-id="files-search-run"
      @click="$emit('search')"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

import IconButton from '@pkg/components/IconButton.vue';

/**
 * Presentational search bar for the container Files tab: a raw text input
 * (v-model) plus status/step-through chrome.  All actual state -- the
 * debounced local filter, the on-demand full-search request/response, and
 * the ancestor-expand-and-reveal walk -- is owned by ContainerFiles.vue, the
 * same way ContainerFileTreeNode.vue only reads `context` and delegates
 * actions upward; this component never touches `nodes` or IPC directly.
 */
export default defineComponent({
  name:       'container-file-search',
  components: { IconButton },
  props: {
    modelValue: {
      type:    String,
      default: '',
    },
    status: {
      type:    String,
      default: 'idle',
    },
    matchCount: {
      type:    Number,
      default: 0,
    },
    revealedCount: {
      type:    Number,
      default: 0,
    },
    currentIndex: {
      type:    Number,
      default: 0,
    },
  },
  emits:    ['update:modelValue', 'search', 'next', 'previous'],
  computed: {
    localValue: {
      get(): string {
        return this.modelValue;
      },
      set(value: string) {
        this.$emit('update:modelValue', value);
      },
    },
  },
});
</script>

<style lang="scss" scoped>
.file-search-widget {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.search-input {
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  background: var(--input-bg);
  color: var(--body-text);
  font-size: 0.875rem;
  padding: 0 0.75rem;
  min-width: 200px;
  height: 32px;
  transition: border-color 0.2s ease;

  &::placeholder {
    color: var(--muted);
  }

  &:focus {
    border-color: var(--primary);
    outline: none;
  }
}

.search-status-icon {
  color: var(--muted);
}

.match-count {
  color: var(--body-text);
  font-size: 0.875rem;
  white-space: nowrap;
}

.search-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
  padding: 0;
  cursor: pointer;
  color: var(--body-text);
  transition: all 0.2s ease;
  min-width: 32px;
  min-height: 32px;

  &:hover:not(:disabled) {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-text);
  }

  &:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  &:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: -2px;
  }
}

// IconButton.vue renders the actual <i> inside its own template, not this
// component's -- a plain scoped ".search-btn .icon" selector can't reach past
// that child-component boundary, so this needs :deep() to size the icon from
// here rather than adding a one-off size prop to IconButton for a single caller.
.search-btn :deep(.icon) {
  font-size: 0.75rem;
}
</style>
