import { defineComponent } from 'vue';

import {
  clampPaneHeight, MIN_PANE_HEIGHT, MIN_TREE_HEIGHT_FRACTION, resizedPaneHeight,
} from '@pkg/components/containerFilesHelpers';

/**
 * Drag-to-resize behavior for the handle between ContainerFiles.vue's file
 * tree and preview pane. Split out as its own mixin (rather than a child
 * component) because the two panes it measures/resizes ($refs.filePanel,
 * $refs.previewPane) are siblings owned by ContainerFiles.vue's own
 * template, not a DOM subtree this mixin could own itself -- a mixin shares
 * `this` with its host, so it can still read/set those refs directly. Fully
 * self-contained: touches only its own data below plus Vue's own generic
 * $refs API, no host-specific state.
 */
interface PaneResizeMixinData {
  // The preview pane's user-chosen height in px, set by dragging/keying the
  // resize handle -- null means "untouched", falling back to the default
  // CSS max-height: 40% auto-sizing. Deliberately never reset by
  // closePreview()/selectFile()/resetAndOpen(): once chosen, it's a layout
  // preference that should survive selection changes and container switches
  // for the rest of the session, not per-file/per-container state.
  previewPaneHeight:   number | null;
  // Set only while a mouse drag of the resize handle is in progress -- drives
  // a CSS class that suppresses text selection/sets the drag cursor for the
  // whole component, since the mouse moves over arbitrary content mid-drag.
  resizingPreviewPane: boolean;
  // The pointer Y and pane height a mouse drag started from, plus the max
  // height that drag is allowed to reach -- captured once at mousedown
  // (paneBounds() is a live DOM measurement, too expensive/jittery to redo
  // on every mousemove) and reused for the whole drag.
  dragStartY:          number;
  dragStartHeight:     number;
  dragMaxHeight:       number;
}

export default defineComponent({
  data(): PaneResizeMixinData {
    return {
      previewPaneHeight:   null,
      resizingPreviewPane: false,
      dragStartY:          0,
      dragStartHeight:     0,
      dragMaxHeight:       0,
    };
  },
  beforeUnmount() {
    window.removeEventListener('mousemove', this.onResizeMove);
    window.removeEventListener('mouseup', this.onResizeEnd);
  },
  methods: {
    /**
     * The preview pane's current/min/max height, in px, measured live from
     * the DOM -- `max` is derived from how much combined space the tree and
     * preview panes actually have right now (so it adapts to window size),
     * leaving the tree only its proportional floor (MIN_TREE_HEIGHT_FRACTION
     * of that combined space) rather than a fixed px minimum, which left the
     * tree very little room to shrink into. Falls back to sane defaults if
     * called before the panes have mounted (the template calls this once
     * per render for the handle's aria-value* attributes, which can happen
     * before $refs are populated).
     */
    paneBounds(): { current: number, min: number, max: number } {
      const previewPane = this.$refs.previewPane as HTMLElement | undefined;
      const filePanel = this.$refs.filePanel as HTMLElement | undefined;

      if (!previewPane || !filePanel) {
        return { current: this.previewPaneHeight ?? MIN_PANE_HEIGHT, min: MIN_PANE_HEIGHT, max: MIN_PANE_HEIGHT };
      }
      const current = previewPane.getBoundingClientRect().height;
      const combined = current + filePanel.getBoundingClientRect().height;
      const treeMinHeight = combined * MIN_TREE_HEIGHT_FRACTION;

      return { current, min: MIN_PANE_HEIGHT, max: Math.max(MIN_PANE_HEIGHT, combined - treeMinHeight) };
    },
    startResize(event: MouseEvent) {
      const { current, max } = this.paneBounds();

      this.resizingPreviewPane = true;
      this.dragStartY = event.clientY;
      this.dragStartHeight = current;
      this.dragMaxHeight = max;
      window.addEventListener('mousemove', this.onResizeMove);
      window.addEventListener('mouseup', this.onResizeEnd);
    },
    onResizeMove(event: MouseEvent) {
      this.previewPaneHeight = resizedPaneHeight(
        this.dragStartHeight, event.clientY - this.dragStartY, MIN_PANE_HEIGHT, this.dragMaxHeight,
      );
    },
    onResizeEnd() {
      this.resizingPreviewPane = false;
      window.removeEventListener('mousemove', this.onResizeMove);
      window.removeEventListener('mouseup', this.onResizeEnd);
    },
    /** Double-clicking the handle resets to the default auto-sized (max-height: 40%) behavior. */
    resetPaneHeight() {
      this.previewPaneHeight = null;
    },
    /**
     * ArrowUp/ArrowDown resize by a step (larger with Shift); Home/End jump
     * straight to the min/max -- the WAI-ARIA "separator" widget's standard
     * keyboard interaction, since this handle has no native/mouse-only
     * equivalent otherwise reachable from the keyboard.
     */
    onHandleKeydown(event: KeyboardEvent) {
      const { current, min, max } = this.paneBounds();
      const step = event.shiftKey ? 96 : 24;

      switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        this.previewPaneHeight = clampPaneHeight(current + step, min, max);
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.previewPaneHeight = clampPaneHeight(current - step, min, max);
        break;
      case 'Home':
        event.preventDefault();
        this.previewPaneHeight = min;
        break;
      case 'End':
        event.preventDefault();
        this.previewPaneHeight = max;
        break;
      }
    },
  },
});
