/** Public RSS domain types shared by the service, provider, tools, and RPC. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque subscription identifier. */
export type FeedId = Branded<'rss-feed-id'>

/** Brand a validated stored feed id. */
export function FeedId(value: string): FeedId {
  return value as FeedId
}

/** Opaque article identifier. */
export type ArticleId = Branded<'rss-article-id'>

/** Brand a validated stored article id. */
export function ArticleId(value: string): ArticleId {
  return value as ArticleId
}

/** One subscribed RSS or Atom feed. */
export interface RssFeed {
  readonly id: FeedId
  readonly url: string
  readonly title: string
  readonly siteUrl?: string
  readonly description?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastFetchedAt?: number
  readonly error?: string
  readonly unreadCount: number
}

/** Stored RSS article metadata and bounded readable content. */
export interface RssArticle {
  readonly id: ArticleId
  readonly feedId: FeedId
  readonly feedTitle: string
  readonly guid: string
  readonly url?: string
  readonly title: string
  readonly author?: string
  readonly publishedAt?: number
  readonly summary?: string
  readonly content: string
  readonly createdAt: number
  readonly read: boolean
  readonly favorite: boolean
}

/** Filters and pagination for an article query. */
export interface RssArticleQuery {
  readonly query?: string
  readonly feedId?: FeedId
  readonly unreadOnly?: boolean
  readonly favoriteOnly?: boolean
  /** Inclusive lower publication-time bound as Unix milliseconds. */
  readonly since?: number
  /** Inclusive upper publication-time bound as Unix milliseconds. */
  readonly until?: number
  readonly limit: number
  readonly offset: number
}

/** Page returned from an article query. */
export interface RssArticlePage {
  readonly articles: readonly RssArticle[]
  readonly total: number
  readonly nextOffset?: number
}

/** Result of refreshing one subscription. */
export interface RssRefreshResult {
  readonly feedId: FeedId
  readonly title: string
  readonly fetched: number
  readonly inserted: number
  readonly updated: number
}

/** Provider implementation registered with {@link RssRuntime}. */
export interface RssProvider {
  readonly id: string
  available(): boolean
  listFeeds(): Promise<readonly RssFeed[]>
  reorderFeeds(ids: readonly FeedId[]): Promise<void>
  addFeed(url: string, signal?: AbortSignal): Promise<RssFeed>
  removeFeed(id: FeedId): Promise<boolean>
  refreshFeed(id: FeedId, signal?: AbortSignal): Promise<RssRefreshResult>
  refreshAll(signal?: AbortSignal): Promise<readonly RssRefreshResult[]>
  listArticles(query: RssArticleQuery): Promise<RssArticlePage>
  getArticle(id: ArticleId): Promise<RssArticle | undefined>
  setRead(id: ArticleId, read: boolean): Promise<boolean>
  setFavorite(id: ArticleId, favorite: boolean): Promise<boolean>
}
