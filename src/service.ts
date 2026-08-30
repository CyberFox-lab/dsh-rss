/** RSS Service Definition: provider registration and deterministic selection. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ArticleId, FeedId, RssArticle, RssArticlePage, RssArticleQuery, RssFeed,
  RssProvider, RssRefreshResult,
} from './types.ts'

export type {
  ArticleId, FeedId, RssArticle, RssArticlePage, RssArticleQuery, RssFeed,
  RssProvider, RssRefreshResult,
} from './types.ts'
export { ArticleId as articleId, FeedId as feedId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** RSS subscription, refresh, and article-query capability. */
    rss: RssRuntime
  }
}

/** RSS capability error with a stable machine-readable code. */
export class RssError extends Error {
  constructor(message: string, readonly code: 'PROVIDER_UNAVAILABLE' | 'DUPLICATE_PROVIDER' | 'NOT_FOUND' | 'INVALID_INPUT') {
    super(message)
    this.name = 'RssError'
  }
}

/** Provider registry and consumer-facing RSS operations. */
export class RssRuntime extends Service {
  private readonly providers = new Map<string, RssProvider>()

  constructor(ctx: Context) {
    super(ctx, 'rss')
  }

  /** Register a provider for the caller's Cordis lifetime. */
  registerProvider(provider: RssProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new RssError(`RSS provider ${JSON.stringify(provider.id)} is already registered`, 'DUPLICATE_PROVIDER')
    }
    const providers = this.providers
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.id, provider)
      yield () => { providers.delete(provider.id) }
    }, 'rss.registerProvider()')
    return () => { void dispose() }
  }

  /** List subscriptions from the selected provider. */
  listFeeds(): Promise<readonly RssFeed[]> { return this.provider().listFeeds() }

  /** Persist the caller's subscription order. */
  reorderFeeds(ids: readonly FeedId[]): Promise<void> { return this.provider().reorderFeeds(ids) }

  /** Subscribe to and immediately refresh an HTTP(S) feed URL. */
  addFeed(url: string, signal?: AbortSignal): Promise<RssFeed> { return this.provider().addFeed(url, signal) }

  /** Remove a subscription and its articles. */
  removeFeed(id: FeedId): Promise<boolean> { return this.provider().removeFeed(id) }

  /** Refresh one subscription. */
  refreshFeed(id: FeedId, signal?: AbortSignal): Promise<RssRefreshResult> {
    return this.provider().refreshFeed(id, signal)
  }

  /** Refresh every subscription sequentially. */
  refreshAll(signal?: AbortSignal): Promise<readonly RssRefreshResult[]> {
    return this.provider().refreshAll(signal)
  }

  /** Query stored articles with explicit bounds. */
  listArticles(query: RssArticleQuery): Promise<RssArticlePage> {
    return this.provider().listArticles(query)
  }

  /** Read one article by opaque id. */
  getArticle(id: ArticleId): Promise<RssArticle | undefined> { return this.provider().getArticle(id) }

  /** Set one article's read state. */
  setRead(id: ArticleId, read: boolean): Promise<boolean> { return this.provider().setRead(id, read) }

  /** Set one article's favorite state. */
  setFavorite(id: ArticleId, favorite: boolean): Promise<boolean> {
    return this.provider().setFavorite(id, favorite)
  }

  private provider(): RssProvider {
    const available = [...this.providers.values()].filter(provider => provider.available())
    if (available.length === 1 && available[0] !== undefined) return available[0]
    if (available.length === 0) throw new RssError('no usable RSS provider is registered', 'PROVIDER_UNAVAILABLE')
    throw new RssError(`multiple usable RSS providers are registered: ${available.map(item => item.id).join(', ')}`, 'PROVIDER_UNAVAILABLE')
  }
}

export default RssRuntime
