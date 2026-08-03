<template>
  <button
    class="icon-button"
    :disabled="disabled"
    :aria-label="ariaLabel"
    :title="ariaLabel"
    :data-testid="testId"
    @click="$emit('click', $event)"
  >
    <i
      :class="icon"
      aria-hidden="true"
    />
  </button>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

/**
 * A single icon-only button (refresh, close, search prev/next/run, ...).
 * Deliberately doesn't own the button's visual skin (background, border,
 * size) -- callers keep passing their own classes (e.g. "btn btn-sm
 * role-tertiary", or ContainerFileSearch.vue's bordered "search-btn") via
 * the standard class attribute, since those differ by call site. What this
 * component centralizes is the flex-centering fix icon-only content needs:
 * the global .btn/.btn-sm rules (assets/styles/global/_button.scss) center
 * via padding + line-height, which works for a baseline-aligned glyph but
 * leaves an icon font's own glyph-box asymmetry (e.g. "X" sitting visibly
 * left-of-center) uncorrected.
 */
export default defineComponent({
  name:  'icon-button',
  props: {
    /** Full icon class string, e.g. "icon icon-refresh" (may vary reactively, e.g. a spinner while loading). */
    icon: {
      type:     String,
      required: true,
    },
    ariaLabel: {
      type:     String,
      required: true,
    },
    disabled: {
      type:    Boolean,
      default: false,
    },
    testId: {
      type:    String,
      default: undefined,
    },
  },
  emits: ['click'],
});
</script>

<style lang="scss" scoped>
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
