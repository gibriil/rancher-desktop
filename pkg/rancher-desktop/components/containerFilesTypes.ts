/**
 * Shared type declarations for ContainerFiles.vue split out of that
 * component -- not for pure logic (see containerFilesHelpers.ts for that),
 * but for the same underlying reason: this project's ambient `*.vue` module
 * declaration (typings/shims-vue.d.ts) only types a component's default
 * export, since it's a single wildcard declaration covering every `.vue`
 * file and can't know any one file's actual named exports. A type declared
 * and exported from inside a `.vue` file therefore resolves fine for another
 * `.vue` file importing it (the Vue tooling parses the real file there), but
 * not for a plain `.ts` file importing it by path -- which is exactly what
 * ContainerFiles.vue's own mixins (components/mixins/*.ts) need to do for
 * `TreeNode`.
 */

import type { ContainerDirectoryEntry } from '@pkg/backend/containerClient/fileTypes';

/**
 * One directory's worth of state in ContainerFiles.vue's `nodes` map. Keyed
 * by absolute path there -- a flat map instead of a nested structure so any
 * node can be looked up, created, or updated in O(1) regardless of how deep
 * it is, and so several nodes can be independently loading/expanded/
 * truncated at once (a tree, as opposed to the single "current directory"
 * the old breadcrumb browser had).
 */
export interface TreeNode {
  entries:         ContainerDirectoryEntry[] | null; // null = never fetched
  expanded:        boolean;
  loading:         boolean;
  error:           string | null;
  truncated:       boolean;
  totalEntryCount: number | null;
  requestId:       string | null; // the list request this node is currently waiting on, if any
}
