/** JSON contracts carried by the private `/rss` Connection channel. */

import type { RssArticle, RssArticlePage, RssFeed, RssRefreshResult } from './types.ts'

/** RPC endpoint names owned by the RSS plugin. */
export type RssRpcEndpoint =
  | 'feeds/list' | 'feeds/reorder' | 'feeds/add' | 'feeds/remove' | 'feeds/refresh' | 'feeds/refresh-all'
  | 'articles/list' | 'articles/get' | 'articles/read' | 'articles/favorite'

/** Successful endpoint payload map. */
export interface RssRpcResultMap {
  'feeds/list': readonly RssFeed[]
  'feeds/reorder': { readonly reordered: true }
  'feeds/add': RssFeed
  'feeds/remove': { readonly removed: boolean }
  'feeds/refresh': RssRefreshResult
  'feeds/refresh-all': readonly RssRefreshResult[]
  'articles/list': RssArticlePage
  'articles/get': RssArticle
  'articles/read': { readonly changed: boolean }
  'articles/favorite': { readonly changed: boolean }
}
