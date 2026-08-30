/** Local SQLite RSS provider with bounded public-network fetching. */

import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArticleId, FeedId, RssArticle, RssArticlePage, RssArticleQuery, RssFeed,
  RssProvider, RssRefreshResult,
} from './types.ts'
import { ArticleId as articleId, FeedId as feedId } from './types.ts'
import { parseFeedXml, type ParsedFeed } from './parser.ts'

/** Current standalone RSS database layout. */
export const SCHEMA_VERSION = 2

/** SQLite application id protecting unrelated databases from plugin writes. */
export const RSS_APPLICATION_ID = 0x44535253

/** Local-provider configuration after Cordis schema defaults. */
export interface LocalRssConfig {
  readonly databasePath: string
  readonly requestTimeoutMs: number
  readonly maxFeedBytes: number
  readonly maxRedirects: number
  readonly articleLimit: number
}

interface FeedRow {
  id: string
  url: string
  title: string
  site_url: string | null
  description: string | null
  created_at: number
  updated_at: number
  last_fetched_at: number | null
  error: string | null
  sort_order: number
  unread_count: number
}

interface ArticleRow {
  id: string
  feed_id: string
  feed_title: string
  guid: string
  url: string | null
  title: string
  author: string | null
  published_at: number | null
  summary: string | null
  content: string
  created_at: number
  is_read: number
  is_favorite: number
}

/** Concrete RSS provider owning one SQLite handle. */
export class LocalRssProvider implements RssProvider {
  readonly id = 'local'
  private readonly db: DatabaseSync

  private constructor(path: string, private readonly config: LocalRssConfig, db: DatabaseSync) {
    this.databasePath = path
    this.db = db
  }

  /** Resolved database path used by this provider. */
  readonly databasePath: string

  /** Create parent directories, open the database, and validate its ownership. */
  static async open(config: LocalRssConfig): Promise<LocalRssProvider> {
    const path = resolve(config.databasePath)
    await mkdir(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    try {
      configureDatabase(db, path)
      return new LocalRssProvider(path, config, db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  available(): boolean { return true }

  /** Close the synchronous database handle. */
  close(): void { this.db.close() }

  async listFeeds(): Promise<readonly RssFeed[]> {
    const rows = this.db.prepare(`
      SELECT feeds.*,
        (SELECT COUNT(*) FROM articles WHERE articles.feed_id = feeds.id AND is_read = 0) AS unread_count
      FROM feeds ORDER BY sort_order, created_at
    `).all() as unknown as FeedRow[]
    return rows.map(feedFromRow)
  }

  /** Persist a complete caller-selected prefix of the subscription order. */
  async reorderFeeds(ids: readonly FeedId[]): Promise<void> {
    if (ids.length === 0) return
    if (new Set(ids).size !== ids.length) throw new Error('feed order must not contain duplicate ids')
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT id FROM feeds WHERE id IN (${placeholders})`).all(...ids) as unknown as { id: string }[]
    if (rows.length !== ids.length) throw new Error('feed order contains an unknown subscription')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const update = this.db.prepare('UPDATE feeds SET sort_order = ? WHERE id = ?')
      ids.forEach((id, index) => { update.run(index, id) })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async addFeed(url: string, signal?: AbortSignal): Promise<RssFeed> {
    const normalized = normalizeFeedUrl(url)
    const existing = this.db.prepare('SELECT id FROM feeds WHERE url = ?').get(normalized) as { id: string } | undefined
    if (existing !== undefined) {
      await this.refreshFeed(feedId(existing.id), signal)
      const refreshed = (await this.listFeeds()).find(feed => feed.id === existing.id)
      if (refreshed === undefined) throw new Error('RSS feed disappeared after refresh')
      return refreshed
    }

    const parsed = await fetchAndParse(normalized, this.config, signal)
    const now = Date.now()
    const id = feedId(randomUUID())
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { next_order: nextOrder } = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM feeds').get() as { next_order: number }
      this.db.prepare(`
        INSERT INTO feeds (id, url, title, site_url, description, created_at, updated_at, last_fetched_at, error, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(id, normalized, parsed.title, parsed.siteUrl ?? null, parsed.description ?? null, now, now, now, nextOrder)
      this.persistArticles(id, parsed, now)
      this.pruneArticles(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const created = (await this.listFeeds()).find(feed => feed.id === id)
    if (created === undefined) throw new Error('RSS feed was not readable after insertion')
    return created
  }

  async removeFeed(id: FeedId): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM feeds WHERE id = ?').run(id)
    return result.changes > 0
  }

  async refreshFeed(id: FeedId, signal?: AbortSignal): Promise<RssRefreshResult> {
    const row = this.db.prepare('SELECT url, title FROM feeds WHERE id = ?').get(id) as { url: string; title: string } | undefined
    if (row === undefined) throw new Error(`RSS feed ${JSON.stringify(id)} was not found`)
    try {
      const parsed = await fetchAndParse(row.url, this.config, signal)
      const now = Date.now()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const counts = this.persistArticles(id, parsed, now)
        this.db.prepare(`
          UPDATE feeds SET title = ?, site_url = ?, description = ?, updated_at = ?, last_fetched_at = ?, error = NULL
          WHERE id = ?
        `).run(parsed.title, parsed.siteUrl ?? null, parsed.description ?? null, now, now, id)
        this.pruneArticles(id)
        this.db.exec('COMMIT')
        return { feedId: id, title: parsed.title, fetched: parsed.articles.length, ...counts }
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      if (!signal?.aborted) {
        this.db.prepare('UPDATE feeds SET error = ?, updated_at = ? WHERE id = ?')
          .run(error instanceof Error ? error.message : String(error), Date.now(), id)
      }
      throw error
    }
  }

  async refreshAll(signal?: AbortSignal): Promise<readonly RssRefreshResult[]> {
    const ids = this.db.prepare('SELECT id FROM feeds ORDER BY sort_order, created_at').all() as unknown as { id: string }[]
    const results: RssRefreshResult[] = []
    for (const row of ids) {
      signal?.throwIfAborted()
      results.push(await this.refreshFeed(feedId(row.id), signal))
    }
    return results
  }

  async listArticles(query: RssArticleQuery): Promise<RssArticlePage> {
    assertPageBounds(query.limit, query.offset)
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (query.feedId !== undefined) { clauses.push('articles.feed_id = ?'); values.push(query.feedId) }
    if (query.unreadOnly === true) clauses.push('articles.is_read = 0')
    if (query.favoriteOnly === true) clauses.push('articles.is_favorite = 1')
    if (query.since !== undefined) { clauses.push('COALESCE(articles.published_at, articles.created_at) >= ?'); values.push(query.since) }
    if (query.until !== undefined) { clauses.push('COALESCE(articles.published_at, articles.created_at) <= ?'); values.push(query.until) }
    const term = query.query?.trim()
    if (term !== undefined && term !== '') {
      clauses.push("(articles.title LIKE ? ESCAPE '\\' OR articles.summary LIKE ? ESCAPE '\\' OR articles.content LIKE ? ESCAPE '\\')")
      const pattern = `%${escapeLike(term)}%`
      values.push(pattern, pattern, pattern)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const count = this.db.prepare(`SELECT COUNT(*) AS count FROM articles ${where}`).get(...values) as { count: number }
    const rows = this.db.prepare(`
      SELECT articles.*, feeds.title AS feed_title
      FROM articles JOIN feeds ON feeds.id = articles.feed_id
      ${where}
      ORDER BY COALESCE(articles.published_at, articles.created_at) DESC, articles.id
      LIMIT ? OFFSET ?
    `).all(...values, query.limit, query.offset) as unknown as ArticleRow[]
    const next = query.offset + rows.length
    return {
      articles: rows.map(articleFromRow),
      total: count.count,
      ...(next < count.count ? { nextOffset: next } : {}),
    }
  }

  async getArticle(id: ArticleId): Promise<RssArticle | undefined> {
    const row = this.db.prepare(`
      SELECT articles.*, feeds.title AS feed_title
      FROM articles JOIN feeds ON feeds.id = articles.feed_id WHERE articles.id = ?
    `).get(id) as unknown as ArticleRow | undefined
    return row === undefined ? undefined : articleFromRow(row)
  }

  async setRead(id: ArticleId, read: boolean): Promise<boolean> {
    return this.db.prepare('UPDATE articles SET is_read = ? WHERE id = ?').run(read ? 1 : 0, id).changes > 0
  }

  async setFavorite(id: ArticleId, favorite: boolean): Promise<boolean> {
    return this.db.prepare('UPDATE articles SET is_favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id).changes > 0
  }

  private persistArticles(feed: FeedId, parsed: ParsedFeed, now: number): { inserted: number; updated: number } {
    const find = this.db.prepare('SELECT id FROM articles WHERE feed_id = ? AND guid = ?')
    const insert = this.db.prepare(`
      INSERT INTO articles
        (id, feed_id, guid, url, title, author, published_at, summary, content, created_at, is_read, is_favorite)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    `)
    const update = this.db.prepare(`
      UPDATE articles SET url = ?, title = ?, author = ?, published_at = ?, summary = ?, content = ?
      WHERE id = ?
    `)
    let inserted = 0
    let updated = 0
    for (const article of parsed.articles) {
      const existing = find.get(feed, article.guid) as { id: string } | undefined
      if (existing === undefined) {
        insert.run(randomUUID(), feed, article.guid, article.url ?? null, article.title, article.author ?? null,
          article.publishedAt ?? null, article.summary ?? null, article.content, now)
        inserted += 1
      } else {
        update.run(article.url ?? null, article.title, article.author ?? null, article.publishedAt ?? null,
          article.summary ?? null, article.content, existing.id)
        updated += 1
      }
    }
    return { inserted, updated }
  }

  private pruneArticles(feed: FeedId): void {
    this.db.prepare(`
      DELETE FROM articles WHERE feed_id = ? AND id NOT IN (
        SELECT id FROM articles WHERE feed_id = ?
        ORDER BY COALESCE(published_at, created_at) DESC, id LIMIT ?
      ) AND is_favorite = 0
    `).run(feed, feed, this.config.articleLimit)
  }
}

function configureDatabase(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get() as { count: number }
    if (version === 0 && (applicationId !== 0 || count > 0)) {
      throw new Error(`RSS database at ${JSON.stringify(path)} has an unversioned schema or application identity`)
    }
    if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
      throw new Error(`RSS database schema version ${String(version)} is incompatible with ${String(SCHEMA_VERSION)}`)
    }
    if (version !== 0 && applicationId !== RSS_APPLICATION_ID) {
      throw new Error(`RSS database application id ${String(applicationId)} is not owned by this plugin`)
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS feeds (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        site_url TEXT,
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_fetched_at INTEGER,
        error TEXT,
        sort_order INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        guid TEXT NOT NULL,
        url TEXT,
        title TEXT NOT NULL,
        author TEXT,
        published_at INTEGER,
        summary TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)),
        is_favorite INTEGER NOT NULL CHECK (is_favorite IN (0, 1)),
        UNIQUE (feed_id, guid)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS articles_recency ON articles(feed_id, published_at DESC, created_at DESC);
    `)
    if (version === 1) {
      db.exec('ALTER TABLE feeds ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      const legacyFeeds = db.prepare('SELECT id FROM feeds ORDER BY title COLLATE NOCASE, created_at').all() as unknown as { id: string }[]
      const updateOrder = db.prepare('UPDATE feeds SET sort_order = ? WHERE id = ?')
      legacyFeeds.forEach((feed, index) => { updateOrder.run(index, feed.id) })
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    } else if (version === 0) {
      db.exec(`PRAGMA application_id = ${String(RSS_APPLICATION_ID)}`)
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    }
    db.exec('CREATE INDEX IF NOT EXISTS feeds_sort_order ON feeds(sort_order, created_at)')
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* Preserve the schema error. */ }
    throw error
  }
  db.exec('PRAGMA journal_mode = WAL')
}

function feedFromRow(row: FeedRow): RssFeed {
  return {
    id: feedId(row.id), url: row.url, title: row.title,
    ...(row.site_url !== null ? { siteUrl: row.site_url } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.last_fetched_at !== null ? { lastFetchedAt: row.last_fetched_at } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    unreadCount: row.unread_count,
  }
}

function articleFromRow(row: ArticleRow): RssArticle {
  return {
    id: articleId(row.id), feedId: feedId(row.feed_id), feedTitle: row.feed_title, guid: row.guid,
    ...(row.url !== null ? { url: row.url } : {}), title: row.title,
    ...(row.author !== null ? { author: row.author } : {}),
    ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
    ...(row.summary !== null ? { summary: row.summary } : {}),
    content: row.content, createdAt: row.created_at, read: row.is_read === 1, favorite: row.is_favorite === 1,
  }
}

function assertPageBounds(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('article limit must be an integer from 1 to 100')
  if (!Number.isInteger(offset) || offset < 0) throw new Error('article offset must be a non-negative integer')
}

function escapeLike(value: string): string { return value.replace(/[\\%_]/gu, match => `\\${match}`) }

function normalizeFeedUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('feed URL must be an absolute HTTP(S) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('feed URL must use HTTP or HTTPS')
  if (url.username !== '' || url.password !== '') throw new Error('feed URL must not contain credentials')
  url.hash = ''
  return url.href
}

async function fetchAndParse(url: string, config: LocalRssConfig, outerSignal?: AbortSignal): Promise<ParsedFeed> {
  const timeout = AbortSignal.timeout(config.requestTimeoutMs)
  const signal = outerSignal === undefined ? timeout : AbortSignal.any([outerSignal, timeout])
  let current = normalizeFeedUrl(url)
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    await assertPublicUrl(current)
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: {
        accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
        'user-agent': '@deepseek-ai/dsh-rss/0.1',
      },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) throw new Error(`feed redirect ${String(response.status)} has no Location header`)
      if (redirects === config.maxRedirects) throw new Error(`feed exceeded ${String(config.maxRedirects)} redirects`)
      current = normalizeFeedUrl(new URL(location, current).href)
      continue
    }
    if (!response.ok) throw new Error(`feed request failed with HTTP ${String(response.status)}`)
    const announced = Number(response.headers.get('content-length'))
    if (Number.isFinite(announced) && announced > config.maxFeedBytes) {
      throw new Error(`feed body exceeds ${String(config.maxFeedBytes)} bytes`)
    }
    const xml = await readBoundedText(response, config.maxFeedBytes)
    return parseFeedXml(xml, current)
  }
  throw new Error('unreachable RSS redirect state')
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) throw new Error(`feed body exceeds ${String(limit)} bytes`)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

async function assertPublicUrl(input: string): Promise<void> {
  const url = new URL(input)
  const literal = isIP(url.hostname)
  const addresses = literal === 0
    ? await lookup(url.hostname, { all: true, verbatim: true })
    : [{ address: url.hostname, family: literal }]
  if (addresses.length === 0) throw new Error(`feed host ${JSON.stringify(url.hostname)} did not resolve`)
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) throw new Error(`feed host resolves to a private or local address: ${entry.address}`)
  }
}

function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower)?.[1]
  const ipv4 = mapped ?? (isIP(address) === 4 ? address : undefined)
  if (ipv4 === undefined) return false
  const octets = ipv4.split('.').map(Number)
  const [a = 0, b = 0] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}
