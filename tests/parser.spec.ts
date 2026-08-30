import { describe, expect, it } from 'vitest'
import { parseFeedXml } from '../src/parser.ts'

describe('parseFeedXml', () => {
  it('normalizes RSS content, dates, relative URLs, and HTML', () => {
    const feed = parseFeedXml(`<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Example RSS</title><link>https://example.com/</link><description>A feed</description>
        <item><guid>a-1</guid><title>First &amp; best</title><link>/posts/1</link>
          <pubDate>Tue, 19 Aug 2025 08:00:00 GMT</pubDate>
          <description><![CDATA[<p>Hello <strong>world</strong>.</p>]]></description>
        </item>
      </channel></rss>`, 'https://example.com/feed.xml')
    expect(feed.title).toBe('Example RSS')
    expect(feed.siteUrl).toBe('https://example.com/')
    expect(feed.articles).toEqual([expect.objectContaining({
      guid: 'a-1', title: 'First & best', url: 'https://example.com/posts/1',
      summary: 'Hello world.', content: 'Hello world.',
      publishedAt: Date.parse('Tue, 19 Aug 2025 08:00:00 GMT'),
    })])
  })

  it('normalizes Atom links, authors, and content', () => {
    const feed = parseFeedXml(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example Atom</title><link rel="alternate" href="https://example.org/" />
        <entry><id>tag:example.org,2025:1</id><title>Atom entry</title>
          <link href="/entry/1"/><author><name>Alice</name></author>
          <updated>2025-08-19T09:00:00Z</updated><content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content>
        </entry>
      </feed>`, 'https://example.org/atom.xml')
    expect(feed.articles[0]).toEqual(expect.objectContaining({
      guid: 'tag:example.org,2025:1', title: 'Atom entry', author: 'Alice',
      url: 'https://example.org/entry/1', content: 'Atom body',
    }))
  })

  it('rejects unrelated XML documents', () => {
    expect(() => parseFeedXml('<html><body>no feed</body></html>', 'https://example.com/')).toThrow('neither RSS nor Atom')
  })
})
