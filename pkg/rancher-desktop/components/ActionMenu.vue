<script>
import $ from 'jquery';
import { mapGetters } from 'vuex';

import { isAlternate } from '@pkg/utils/platform';
import { AUTO, fitOnScreen, LEFT } from '@pkg/utils/position';

const HIDDEN = 'hide';
const CALC = 'calculate';
const SHOW = 'show';

export default {
  data() {
    return {
      phase: HIDDEN,
      style: {},
      // Whatever had focus right before the menu opened -- captured here
      // rather than derived from targetElem/targetEvent, since those are
      // positioning hints (may point at a label element that was never
      // itself focusable, or an event whose currentTarget is already null
      // by the time the menu closes) and not reliably "the thing to
      // refocus" in every case.
      returnFocusTo: null,
    };
  },

  computed: {
    ...mapGetters({
      targetElem:  'action-menu/elem',
      targetEvent: 'action-menu/event',
      shouldShow:  'action-menu/showing',
      options:     'action-menu/options',
    }),

    showing() {
      return this.phase !== HIDDEN;
    },

  },

  watch: {
    shouldShow: {
      handler(show) {
        if ( show ) {
          this.returnFocusTo = document.activeElement;
          this.phase = CALC;
          this.updateStyle();
          this.$nextTick(() => {
            if ( this.phase === CALC ) {
              this.phase = SHOW;
              this.updateStyle();
              // Another tick: the style change above (visibility: hidden ->
              // visible) hasn't reached the DOM yet in this same tick, and a
              // still visibility:hidden element can't take focus.
              this.$nextTick(() => this.focusFirstItem());
            }
          });
        } else {
          this.phase = HIDDEN;
        }
      },
    },

    '$route.path'(val, old) {
      this.hide();
    },
  },

  methods: {
    hide() {
      this.$store.commit('action-menu/hide');
    },

    updateStyle() {
      if ( this.phase === SHOW ) {
        const menu = $('.menu', this.$el)[0];
        const event = this.targetEvent;
        const elem = this.targetElem;

        this.style = fitOnScreen(menu, event || elem, {
          // True for a keyboard-opened menu (elem set, e.g. Shift+F10 on a
          // tree row): it should hang flush over/from its trigger, the same
          // way a native dropdown does. False for a mouse-opened one (only
          // a click event, no elem): the trigger there is just the cursor
          // point, and the menu should sit beside it rather than under it,
          // so it doesn't cover whatever's under the cursor.
          overlapX:  !!elem,
          // Positive for a keyboard-opened menu -- with overlapX true this
          // nudges it slightly further over the trigger for a flush look,
          // matching this component's original behavior for an elem-anchored
          // menu. Irrelevant for a mouse-opened one (0).
          fudgeX:    elem ? 4 : 0,
          fudgeY:    elem ? 4 : 0,
          // The menu's own left edge aligns to the trigger -- for a
          // keyboard-opened menu (overlapX true) that lands the menu right
          // over the name label; for a mouse-opened one (overlapX false)
          // it lands the menu just to the right of the cursor instead of
          // centered on/covering it. position.js's fitOnScreen falls back
          // to the opposite side if this would run off the right edge of
          // the screen.
          positionX: LEFT,
          positionY: AUTO,
        });

        this.style.visibility = 'visible';
      } else {
        this.style = {};
      }
    },

    execute(action, event, args) {
      const opts = { alt: isAlternate(event) };

      this.$store.dispatch('action-menu/execute', {
        action, args, opts,
      });
      this.hideAndReturnFocus();
    },

    hasOptions(options) {
      return options.length !== undefined ? options.length : Object.keys(options).length > 0;
    },

    /** All real (non-divider-only, non-"no actions") menu item elements, in rendered order. */
    menuItems() {
      const refs = this.$refs.menuItem;

      if (!refs) return [];

      return Array.isArray(refs) ? refs : [refs];
    },

    focusFirstItem() {
      this.menuItems()[0]?.focus();
    },

    /**
     * Arrow-key roving focus, a Tab/Shift+Tab focus trap, and Escape-to-
     * dismiss for the menu -- this component previously had no keyboard
     * operability at all once opened (no tabindex/role on items, nothing
     * handling Escape/Tab/the arrow keys), which meant even a
     * keyboard-opened menu couldn't actually be used without a mouse, and
     * Tab would escape straight through to whatever was behind it (e.g. the
     * file tree). Space is also preventDefault'd here (its default action,
     * a page scroll, fires on keydown) even though *activating* an item on
     * Space happens on keyup below.
     */
    onItemKeydown(event) {
      const items = this.menuItems();
      const index = items.indexOf(event.currentTarget);
      const focusNext = () => items[(index + 1) % items.length]?.focus();
      const focusPrevious = () => items[(index - 1 + items.length) % items.length]?.focus();

      switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusNext();
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusPrevious();
        break;
      case 'Tab':
        // Trap focus inside the open menu -- a native/OS context menu isn't
        // part of the page's normal tab order, so Tab/Shift+Tab cycle
        // between its own items instead of moving on to whatever's behind it.
        event.preventDefault();
        if (event.shiftKey) {
          focusPrevious();
        } else {
          focusNext();
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.hideAndReturnFocus();
        break;
      case ' ':
        event.preventDefault();
        break;
      }
    },

    /**
     * Activates an item on keyup, not keydown -- matching native <button>
     * activation timing, so a held key's OS repeat can't re-fire this
     * multiple times, and so Space's default page-scroll (already
     * prevented on keydown above) doesn't race with activation.
     */
    onItemKeyup(opt, event) {
      if (event.key === 'Enter' || event.key === ' ') {
        this.execute(opt, event);
      }
    },

    /**
     * Closes the menu and restores focus to whatever had it right before
     * the menu opened -- used for both dismissing via Escape and for
     * closing after an item is actually chosen, so neither path leaves
     * focus stranded on a now-hidden menu item.
     */
    hideAndReturnFocus() {
      const target = this.returnFocusTo;

      this.hide();
      target?.focus?.();
    },
  },
};
</script>

<template>
  <div v-if="showing">
    <div
      class="background"
      @click="hide"
      @contextmenu.prevent="hide"
    />
    <ul
      class="list-unstyled menu"
      role="menu"
      :style="style"
    >
      <li
        v-for="opt in options"
        :key="opt.action"
        ref="menuItem"
        tabindex="-1"
        role="menuitem"
        :class="{ divider: opt.divider }"
        @click="execute(opt, $event)"
        @keydown="onItemKeydown($event)"
        @keyup="onItemKeyup(opt, $event)"
      >
        <i
          v-if="opt.icon"
          :class="{ icon: true, [opt.icon]: true }"
        />
        <span v-html="opt.label" />
      </li>
      <li
        v-if="!hasOptions(options)"
        class="no-actions"
      >
        <span v-t="'sortableTable.noActions'" />
      </li>
    </ul>
  </div>
</template>

<style lang="scss" scoped>
  .root {
    position: absolute;
  }

  .menu {
    position: absolute;
    visibility: hidden;
    top: 0;
    left: 0;
    z-index: z-index('dropdownContent');

    color: var(--dropdown-text);
    background-color: var(--dropdown-bg);
    border: 1px solid var(--dropdown-border);
    border-radius: 5px;
    box-shadow: 0 5px 20px var(--shadow);

    LI {
      display: flex;
      align-items: center;
      // Matches the LI's own left/right padding, so the icon-to-label gap
      // reads the same as the edge-to-icon gap instead of the incidental
      // sliver of space an inline <i>/<span> pair would otherwise get from
      // the whitespace between them in the template.
      gap: 10px;
      padding: 10px;
      margin: 0;

      &.divider {
        padding: 0;
        border-bottom: 1px solid var(--dropdown-divider);
      }

      &:not(.divider):hover {
        background-color: var(--dropdown-hover-bg);
        color: var(--dropdown-hover-text);
        cursor: pointer;
      }

      .icon {
        display: unset;
      }

      &.no-actions {
        color: var(--disabled-text);
      }

      &.no-actions:hover {
        background-color: initial;
        color: var(--disabled-text);
        cursor: default;
      }
    }
  }

  .background {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    opacity: 0;
    z-index: z-index('dropdownOverlay');
  }
</style>
