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
        <button
          :disabled="matchCount < 2"
          :aria-label="t('containerFiles.search.previousMatch')"
          class="search-btn btn role-tertiary"
          data-testid="files-search-prev-btn"
          :title="t('containerFiles.search.previousMatch')"
          @click="$emit('previous')"
        >
          <i
            aria-hidden="true"
            class="icon icon-chevron-up"
          />
        </button>
        <button
          :disabled="matchCount < 2"
          :aria-label="t('containerFiles.search.nextMatch')"
          class="search-btn btn role-tertiary"
          data-testid="files-search-next-btn"
          :title="t('containerFiles.search.nextMatch')"
          @click="$emit('next')"
        >
          <i
            aria-hidden="true"
            class="icon icon-chevron-down"
          />
        </button>
      </template>
    </template>

    <button
      :disabled="!modelValue"
      :aria-label="t('containerFiles.search.searchAll')"
      class="search-btn btn role-tertiary"
      data-testid="files-search-run"
      :title="t('containerFiles.search.searchAll')"
      @click="$emit('search')"
    >
      <i
        aria-hidden="true"
        class="icon icon-search"
      />
    </button>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

/**
 * Presentational search bar for the container Files tab: a raw text input
 * (v-model) plus status/step-through chrome.  All actual state -- the
 * debounced local filter, the on-demand full-search request/response, and
 * the ancestor-expand-and-reveal walk -- is owned by ContainerFiles.vue, the
 * same way ContainerFileTreeNode.vue only reads `context` and delegates
 * actions upward; this component never touches `nodes` or IPC directly.
 */
export default defineComponent({
  name:  'container-file-search',
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
  display: flex;
  align-items: center;
  justify-content: center;
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

  .icon {
    font-size: 0.75rem;
  }
}
</style>
