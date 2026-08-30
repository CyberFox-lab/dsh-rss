/** Observable visibility state for the root-scoped RSS application. */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Stable RSS application visibility snapshot. */
export interface RssUiSnapshot { readonly open: boolean }

/** Create the shared RSS application visibility source and actions. */
export function createRssUiStore(): {
  source: HostObservable<RssUiSnapshot>
  close(): void
  toggle(): void
} {
  const listeners = new Set<() => void>()
  let snapshot: RssUiSnapshot = { open: false }
  const set = (open: boolean): void => {
    if (snapshot.open === open) return
    snapshot = { open }
    for (const listener of listeners) listener()
  }
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    close: () => { set(false) }, toggle: () => { set(!snapshot.open) },
  }
}
