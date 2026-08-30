import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalRssProvider, RSS_APPLICATION_ID, SCHEMA_VERSION, type LocalRssConfig } from '../src/local-provider.ts'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function provider(): Promise<LocalRssProvider> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rss-test-'))
  roots.push(root)
  return LocalRssProvider.open(configAt(join(root, 'rss.sqlite')))
}

function configAt(databasePath: string): LocalRssConfig {
  return {
    databasePath, requestTimeoutMs: 5_000,
    maxFeedBytes: 100_000, maxRedirects: 2, articleLimit: 100,
  }
}

function response(title: string, second = false): Response {
  return new Response(`<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Test feed</title><link>https://example.com/</link>
    <item><guid>one</guid><title>${title}</title><link>https://example.com/one</link><description>alpha body</description></item>
    ${second ? '<item><guid>two</guid><title>Second</title><link>https://example.com/two</link><description>beta body</description></item>' : ''}
  </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
}

function datedResponse(): Response {
  return new Response(`<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Dated feed</title><link>https://example.com/</link>
    <item><guid>old</guid><title>Old</title><pubDate>Mon, 10 Aug 2026 08:00:00 GMT</pubDate><description>old body</description></item>
    <item><guid>new</guid><title>New</title><pubDate>Thu, 20 Aug 2026 08:00:00 GMT</pubDate><description>new body</description></item>
  </channel></rss>`, { status: 200, headers: { 'content-type': 'application/rss+xml' } })
}

describe('LocalRssProvider', () => {
  it('adds, refreshes, searches, and preserves article state across updates', async () => {
    const fetchMock = vi.fn(async () => response('First'))
    vi.stubGlobal('fetch', fetchMock)
    const rss = await provider()
    try {
      const feed = await rss.addFeed('https://example.com/feed.xml')
      expect(feed.title).toBe('Test feed')
      expect(feed.unreadCount).toBe(1)
      const firstPage = await rss.listArticles({ query: 'alpha', limit: 10, offset: 0 })
      const first = firstPage.articles[0]
      expect(first).toMatchObject({ title: 'First', content: 'alpha body', read: false, favorite: false })
      if (first === undefined) throw new Error('missing article fixture')
      await rss.setRead(first.id, true)
      await rss.setFavorite(first.id, true)

      fetchMock.mockImplementation(async () => response('First updated', true))
      const refreshed = await rss.refreshFeed(feed.id)
      expect(refreshed).toMatchObject({ fetched: 2, inserted: 1, updated: 1 })
      const articles = await rss.listArticles({ limit: 10, offset: 0 })
      expect(articles.total).toBe(2)
      expect(articles.articles.find(article => article.id === first.id)).toMatchObject({
        title: 'First updated', read: true, favorite: true,
      })
    } finally {
      rss.close()
    }
  })

  it('deduplicates an existing subscription by normalized URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('First')))
    const rss = await provider()
    try {
      const first = await rss.addFeed('https://example.com/feed.xml#fragment')
      const second = await rss.addFeed('https://example.com/feed.xml')
      expect(second.id).toBe(first.id)
      expect(await rss.listFeeds()).toHaveLength(1)
    } finally {
      rss.close()
    }
  })

  it('migrates the previous schema and persists a manual subscription order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rss-test-'))
    roots.push(root)
    const databasePath = join(root, 'rss.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE feeds (
        id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, site_url TEXT,
        description TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_fetched_at INTEGER, error TEXT
      ) STRICT;
      INSERT INTO feeds VALUES ('b', 'https://example.com/b.xml', 'Beta', NULL, NULL, 1, 1, NULL, NULL);
      INSERT INTO feeds VALUES ('a', 'https://example.com/a.xml', 'Alpha', NULL, NULL, 2, 2, NULL, NULL);
      PRAGMA application_id = ${String(RSS_APPLICATION_ID)};
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const rss = await LocalRssProvider.open(configAt(databasePath))
    expect((await rss.listFeeds()).map(feed => feed.id)).toEqual(['a', 'b'])
    await rss.reorderFeeds((await rss.listFeeds()).map(feed => feed.id).reverse())
    rss.close()

    const reopened = await LocalRssProvider.open(configAt(databasePath))
    try {
      expect((await reopened.listFeeds()).map(feed => feed.id)).toEqual(['b', 'a'])
      const db = new DatabaseSync(databasePath, { readOnly: true })
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
      db.close()
    } finally {
      reopened.close()
    }
  })

  it('lists newest articles by inclusive date bounds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => datedResponse()))
    const rss = await provider()
    try {
      await rss.addFeed('https://example.com/dated.xml')
      const since = Date.parse('2026-08-15T00:00:00.000Z')
      const recent = await rss.listArticles({ since, limit: 10, offset: 0 })
      expect(recent.articles.map(article => article.title)).toEqual(['New'])

      const until = Date.parse('2026-08-20T23:59:59.999Z')
      const page = await rss.listArticles({ until, limit: 1, offset: 0 })
      expect(page).toMatchObject({ total: 2, nextOffset: 1 })
      expect(page.articles.map(article => article.title)).toEqual(['New'])
    } finally {
      rss.close()
    }
  })

  it('rejects bodies beyond the configured byte cap without creating a feed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(100_001), { status: 200 })))
    const rss = await provider()
    try {
      await expect(rss.addFeed('https://example.com/large.xml')).rejects.toThrow('exceeds 100000 bytes')
      expect(await rss.listFeeds()).toEqual([])
    } finally {
      rss.close()
    }
  })
})
