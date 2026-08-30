import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as RssPlugin from '../src/index.ts'
import { LocalRssProvider } from '../src/local-provider.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RSS plugin composition', () => {
  it('mounts the service, provider, tools, prompt guidance, and RPC as one disposable plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rss-load-'))
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    try {
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(ToolRuntime))
      const handle = () => async (): Promise<void> => {}
      ctx.provide('connection', { rpc: { handle } } as never)
      fibers.push(await ctx.plugin(RssPlugin, {
        databasePath: join(root, 'rss.sqlite'), requestTimeoutMs: 5_000,
        maxFeedBytes: 100_000, maxRedirects: 2, articleLimit: 100, toolTimeoutMs: 5_000,
      }))

      expect(await ctx.rss.listFeeds()).toEqual([])
      expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
        'rss_list_feeds', 'rss_list_articles', 'rss_search_articles', 'rss_read_article',
      ])
      expect(ctx.tools.schemas().find(tool => tool.name === 'rss_list_articles')?.parameters)
        .toMatchObject({
          type: 'object', properties: {
            feedId: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' },
            unreadOnly: { type: 'boolean' }, favoriteOnly: { type: 'boolean' },
            includeContent: { type: 'boolean' },
            limit: { type: 'integer' }, offset: { type: 'integer' },
          },
        })
      const listArticles = vi.spyOn(LocalRssProvider.prototype, 'listArticles').mockResolvedValue({
        total: 1,
        articles: [{
          id: 'article-1', feedId: 'feed-1', feedTitle: 'Feed', guid: 'guid-1',
          title: 'Long article', content: 'x'.repeat(5_001), createdAt: 1,
          read: false, favorite: false,
        } as never],
      })
      const listTool = ctx.tools.get('rss_list_articles')
      if (listTool === undefined) throw new Error('rss_list_articles was not registered')
      const listed = await listTool.execute({ includeContent: true }, {} as never) as {
        articles: Array<{ content: string | null; contentTruncated: boolean }>
      }
      expect(listArticles).toHaveBeenCalledWith({ limit: 30, offset: 0 })
      expect(listed.articles[0]).toMatchObject({ content: 'x'.repeat(5_000), contentTruncated: true })
      vi.spyOn(LocalRssProvider.prototype, 'getArticle').mockResolvedValue({
        id: 'article-1', feedId: 'feed-1', feedTitle: 'Feed', guid: 'guid-1',
        title: 'Long article', content: 'x'.repeat(25_001), createdAt: 1,
        read: false, favorite: false,
      } as never)
      const readTool = ctx.tools.get('rss_read_article')
      if (readTool === undefined) throw new Error('rss_read_article was not registered')
      const read = await readTool.execute({ articleId: 'article-1' }, {} as never) as {
        content: string; start: number; nextStart: number | null
      }
      expect(read).toMatchObject({ content: 'x'.repeat(25_000), start: 0, nextStart: 25_000 })
      const prompt = await ctx.systemPrompt.assemble()
      expect(prompt.sections.some(section => section.name === 'tool:rss')).toBe(true)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refreshes all subscriptions every hour without leaving a timer after disposal', async () => {
    vi.useFakeTimers()
    const refreshAll = vi.spyOn(LocalRssProvider.prototype, 'refreshAll').mockResolvedValue([])
    const root = await mkdtemp(join(tmpdir(), 'dsh-rss-auto-refresh-'))
    const ctx = new Context()
    const fibers: Array<{ dispose(): Promise<void> }> = []
    try {
      fibers.push(await ctx.plugin(SystemPrompt))
      fibers.push(await ctx.plugin(ToolRuntime))
      const handle = () => async (): Promise<void> => {}
      ctx.provide('connection', { rpc: { handle } } as never)
      const rssFiber = await ctx.plugin(RssPlugin, {
        databasePath: join(root, 'rss.sqlite'), requestTimeoutMs: 5_000,
        maxFeedBytes: 100_000, maxRedirects: 2, articleLimit: 100, toolTimeoutMs: 5_000,
        autoRefreshIntervalMs: 60 * 60 * 1_000,
      })
      fibers.push(rssFiber)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000 - 1)
      expect(refreshAll).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(refreshAll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
      expect(refreshAll).toHaveBeenCalledTimes(2)

      await rssFiber.dispose()
      fibers.pop()
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
      expect(refreshAll).toHaveBeenCalledTimes(2)
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
