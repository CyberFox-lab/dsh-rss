import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RssPanel, type RssPanelProps } from '../src/client/RssUi.tsx'
import { RSS_STYLE } from '../src/client/styles.ts'

describe('RSS reader workspace', () => {
  it('renders the Reader-derived full-screen workspace without an Agent tab', () => {
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: { getSnapshot: () => ({ running: false, messages: [], workspaces: [], sessions: [], models: [], modelBusy: false }), subscribe: () => () => {} },
      close: () => {}, listFeeds: async () => [], listArticles: async () => ({ articles: [], total: 0 }),
    } as unknown as RssPanelProps

    const markup = renderToStaticMarkup(<RssPanel {...props} />)

    expect(markup).toContain('dsh-rss-topbar')
    expect(markup).toContain('dsh-rss-sources')
    expect(markup).toContain('dsh-rss-articles')
    expect(markup).toContain('dsh-rss-reader')
    expect(markup).toContain('dsh-rss-agent-launcher')
    expect(markup).toContain('拖动或点击展开 Agent')
    expect(markup).not.toContain('dsh-rss-agent-tab')
    expect(RSS_STYLE).toContain('position:fixed;inset:0')
    expect(RSS_STYLE).toContain('.dsh-rss-agent-float{position:fixed')
    expect(RSS_STYLE).toContain('touch-action:none')
    expect(RSS_STYLE).toContain('--rss-accent:#5365f5')
    expect(RSS_STYLE).toContain('background:#eff0ff')
    expect(RSS_STYLE).not.toContain('--rss-orange')
    expect(RSS_STYLE).toContain('.dsh-rss-star[data-active]{background:var(--rss-accent)')
    expect(RSS_STYLE).toContain('.dsh-rss-reader-actions .dsh-rss-reader-star[data-active]')
    expect(RSS_STYLE).toContain('.dsh-rss-app .dsh-rss-mobile-back{display:none}')
    expect(RSS_STYLE).toContain('.dsh-rss-mobile-back{display:inline-flex!important}')
  })
})
