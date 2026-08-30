/** Loopback-only browser RPC consumer over the RSS service. */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { RssRuntime } from './service.ts'
import { ArticleId, FeedId } from './types.ts'
import type { RssArticleQuery } from './types.ts'

/** Register RSS management and reading operations on `/rss`. */
export function registerRssRpc(ctx: Context, rss: RssRuntime): void {
  ctx.connection.rpc.handle('/rss', async (endpoint, payload, signal) => {
    try {
      switch (endpoint) {
        case 'feeds/list': return success(await rss.listFeeds())
        case 'feeds/reorder': {
          await rss.reorderFeeds(requiredStringArray(payload, 'ids').map(FeedId))
          return success({ reordered: true as const })
        }
        case 'feeds/add': return success(await rss.addFeed(requiredString(payload, 'url'), signal))
        case 'feeds/remove': return success({ removed: await rss.removeFeed(FeedId(requiredString(payload, 'id'))) })
        case 'feeds/refresh': return success(await rss.refreshFeed(FeedId(requiredString(payload, 'id')), signal))
        case 'feeds/refresh-all': return success(await rss.refreshAll(signal))
        case 'articles/list': return success(await rss.listArticles(articleQuery(payload)))
        case 'articles/get': {
          const article = await rss.getArticle(ArticleId(requiredString(payload, 'id')))
          return article === undefined ? failure('article was not found') : success(article)
        }
        case 'articles/read': return success({ changed: await rss.setRead(ArticleId(requiredString(payload, 'id')), requiredBoolean(payload, 'read')) })
        case 'articles/favorite': return success({ changed: await rss.setFavorite(ArticleId(requiredString(payload, 'id')), requiredBoolean(payload, 'favorite')) })
        default: return failure(`unknown RSS endpoint ${JSON.stringify(endpoint)}`)
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'internal')
    }
  }, { authority: 'loopback' })
}

function success<T>(value: T): RpcResult<T> { return { ok: true, value } }

function failure<T>(message: string, code: 'bad-request' | 'internal' = 'bad-request'): RpcResult<T> {
  return code === 'bad-request'
    ? { ok: false, error: { code, message, details: { issues: [] } } }
    : { ok: false, error: { code, message, details: {} } }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('RSS request payload must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, key: string): string {
  const field = recordOf(value)[key]
  if (typeof field !== 'string' || field.trim() === '') throw new Error(`${key} must be a non-empty string`)
  return field
}

function requiredBoolean(value: unknown, key: string): boolean {
  const field = recordOf(value)[key]
  if (typeof field !== 'boolean') throw new Error(`${key} must be a boolean`)
  return field
}

function requiredStringArray(value: unknown, key: string): string[] {
  const field = recordOf(value)[key]
  if (!Array.isArray(field) || field.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${key} must be an array of non-empty strings`)
  }
  return field as string[]
}

function articleQuery(value: unknown): RssArticleQuery {
  const record = recordOf(value)
  const query = optionalString(record.query, 'query')
  const feed = optionalString(record.feedId, 'feedId')
  return {
    ...(query !== undefined ? { query } : {}),
    ...(feed !== undefined ? { feedId: FeedId(feed) } : {}),
    ...(optionalBoolean(record.unreadOnly, 'unreadOnly') ?? false ? { unreadOnly: true } : {}),
    ...(optionalBoolean(record.favoriteOnly, 'favoriteOnly') ?? false ? { favoriteOnly: true } : {}),
    limit: optionalInteger(record.limit, 'limit') ?? 30,
    offset: optionalInteger(record.offset, 'offset') ?? 0,
  }
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function optionalInteger(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value as number
}
