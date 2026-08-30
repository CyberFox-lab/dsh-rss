/** Bounded RSS 2.x and Atom XML normalization. */

import { XMLParser } from 'fast-xml-parser'

/** Normalized item produced before persistence. */
export interface ParsedArticle {
  readonly guid: string
  readonly url?: string
  readonly title: string
  readonly author?: string
  readonly publishedAt?: number
  readonly summary?: string
  readonly content: string
}

/** Normalized feed document. */
export interface ParsedFeed {
  readonly title: string
  readonly siteUrl?: string
  readonly description?: string
  readonly articles: readonly ParsedArticle[]
}

type XmlRecord = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  removeNSPrefix: true,
  trimValues: true,
})

/** Parse one RSS or Atom document and reject unsupported roots. */
export function parseFeedXml(xml: string, sourceUrl: string): ParsedFeed {
  const document = asRecord(parser.parse(xml))
  const rss = asRecord(document.rss)
  const channel = asRecord(rss.channel)
  if (Object.keys(channel).length > 0) return parseRss(channel, sourceUrl)
  const feed = asRecord(document.feed)
  if (Object.keys(feed).length > 0) return parseAtom(feed, sourceUrl)
  throw new Error('document is neither RSS nor Atom')
}

function parseRss(channel: XmlRecord, sourceUrl: string): ParsedFeed {
  const title = textOf(channel.title) || sourceUrl
  const siteUrl = absoluteUrl(textOf(channel.link), sourceUrl)
  const description = optionalText(channel.description)
  const articles = arrayOf(channel.item).map((raw, index) => {
    const item = asRecord(raw)
    const url = absoluteUrl(textOf(item.link), sourceUrl)
    const guid = textOf(item.guid) || url || `${title}:${String(index)}:${textOf(item.title)}`
    const contentHtml = textOf(item.encoded) || textOf(item.content) || textOf(item.description)
    const summary = optionalText(item.description)
    const author = optionalText(item.author ?? item.creator)
    const publishedAt = dateOf(item.pubDate ?? item.published ?? item.updated)
    return {
      guid,
      ...(url !== undefined ? { url } : {}),
      title: textOf(item.title) || '(untitled)',
      ...(author !== undefined ? { author } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(summary !== undefined ? { summary: htmlToText(summary) } : {}),
      content: htmlToText(contentHtml),
    }
  })
  return { title, ...(siteUrl !== undefined ? { siteUrl } : {}), ...(description !== undefined ? { description: htmlToText(description) } : {}), articles }
}

function parseAtom(feed: XmlRecord, sourceUrl: string): ParsedFeed {
  const title = textOf(feed.title) || sourceUrl
  const siteUrl = atomLink(feed.link, sourceUrl, 'alternate')
  const description = optionalText(feed.subtitle)
  const articles = arrayOf(feed.entry).map((raw, index) => {
    const item = asRecord(raw)
    const url = atomLink(item.link, sourceUrl, 'alternate')
    const guid = textOf(item.id) || url || `${title}:${String(index)}:${textOf(item.title)}`
    const contentHtml = textOf(item.content) || textOf(item.summary)
    const summary = optionalText(item.summary)
    const authorRecord = asRecord(item.author)
    const author = optionalText(authorRecord.name ?? item.author)
    const publishedAt = dateOf(item.published ?? item.updated)
    return {
      guid,
      ...(url !== undefined ? { url } : {}),
      title: textOf(item.title) || '(untitled)',
      ...(author !== undefined ? { author } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(summary !== undefined ? { summary: htmlToText(summary) } : {}),
      content: htmlToText(contentHtml),
    }
  })
  return { title, ...(siteUrl !== undefined ? { siteUrl } : {}), ...(description !== undefined ? { description: htmlToText(description) } : {}), articles }
}

function asRecord(value: unknown): XmlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlRecord : {}
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ').trim()
  const record = asRecord(value)
  const text = record['#cdata'] ?? record['#text']
  return text === value ? '' : textOf(text)
}

function optionalText(value: unknown): string | undefined {
  const text = textOf(value)
  return text === '' ? undefined : text
}

function dateOf(value: unknown): number | undefined {
  const text = textOf(value)
  if (text === '') return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function atomLink(value: unknown, base: string, relation: string): string | undefined {
  for (const raw of arrayOf(value)) {
    const link = asRecord(raw)
    const rel = textOf(link['@_rel']) || 'alternate'
    if (rel !== relation) continue
    const url = absoluteUrl(textOf(link['@_href']) || textOf(raw), base)
    if (url !== undefined) return url
  }
  return undefined
}

function absoluteUrl(value: string, base: string): string | undefined {
  if (value === '') return undefined
  try { return new URL(value, base).href } catch { return undefined }
}

/** Convert feed-provided HTML to bounded readable plain text without executing it. */
export function htmlToText(value: string): string {
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<\/?(?:p|div|br|li|h[1-6]|blockquote|pre)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ''))
    .replace(/\r/gu, '')
    .replace(/[\t ]+/gu, ' ')
    .replace(/\n[\t ]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named[entity.toLowerCase()] ?? whole
  })
}
