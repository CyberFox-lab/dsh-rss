// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseOpmlFeedUrls, RssPanel, type RssAgentSnapshot, type RssPanelProps } from '../src/client/RssUi.tsx'
import { RSS_STYLE } from '../src/client/styles.ts'
import type { RssArticle, RssFeed } from '../src/types.ts'

afterEach(cleanup)

describe('RSS reader interactions', () => {
  it('changes the article search hint and saves a manual subscription order', async () => {
    const feeds = [{
      id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha', createdAt: 1, updatedAt: 1, unreadCount: 2,
    }, {
      id: 'feed-b', url: 'https://example.com/b.xml', title: 'Beta', createdAt: 2, updatedAt: 2, unreadCount: 1,
    }] as unknown as RssFeed[]
    const reorderFeeds = vi.fn(async () => ({ reordered: true as const }))
    const agentSnapshot = { running: false, messages: [], workspaces: [], sessions: [], models: [], modelBusy: false } as const
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: { getSnapshot: () => agentSnapshot, subscribe: () => () => {} },
      close: () => {}, listFeeds: async () => feeds, listArticles: async () => ({ articles: [], total: 0 }), reorderFeeds,
    } as unknown as RssPanelProps

    const { getByRole, getByPlaceholderText } = render(<RssPanel {...props} />)
    expect(getByPlaceholderText('检索文章')).toBeTruthy()
    await waitFor(() => { expect(getByRole('button', { name: '调整订阅源顺序' }).hasAttribute('disabled')).toBe(false) })
    fireEvent.click(getByRole('button', { name: '调整订阅源顺序' }))
    fireEvent.click(getByRole('button', { name: '下移 Alpha' }))
    fireEvent.click(getByRole('button', { name: '保存排序' }))
    await waitFor(() => {
      expect(reorderFeeds).toHaveBeenCalledWith(['feed-b', 'feed-a'])
    })
  })

  it('parses nested OPML subscriptions and rejects invalid documents', () => {
    expect(parseOpmlFeedUrls(`<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Tech"><outline text="One" xmlUrl="https://example.com/feed.xml" />
      <outline text="Two" xmlurl="https://example.org/atom.xml?x=1&amp;y=2" /></outline>
      <outline text="Duplicate" xmlUrl="https://example.com/feed.xml" /></body></opml>`)).toEqual([
      'https://example.com/feed.xml', 'https://example.org/atom.xml?x=1&y=2',
    ])
    expect(() => { parseOpmlFeedUrls('<rss />') }).toThrow('OPML 文件格式无效')
    expect(() => { parseOpmlFeedUrls('<opml><body /></opml>') }).toThrow('OPML 文件中没有订阅地址')
  })

  it('imports an OPML file into the batch subscription list without adding immediately', async () => {
    const addFeed = vi.fn()
    const agentSnapshot = { running: false, messages: [], workspaces: [], sessions: [], models: [], modelBusy: false } as const
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: { getSnapshot: () => agentSnapshot, subscribe: () => () => {} },
      close: () => {}, listFeeds: async () => [], listArticles: async () => ({ articles: [], total: 0 }), addFeed,
    } as unknown as RssPanelProps

    const { container, getByRole, getByText } = render(<RssPanel {...props} />)
    fireEvent.click(container.querySelector('button[title="添加订阅"]')!)
    const textarea = getByRole('textbox', { name: '订阅地址' })
    fireEvent.change(textarea, { target: { value: 'https://example.com/existing.xml' } })
    const file = {
      name: 'subscriptions.opml',
      text: vi.fn(async () => '<opml version="2.0"><body><outline xmlUrl="https://example.com/existing.xml"/><outline xmlUrl="https://example.org/imported.xml"/></body></opml>'),
    }
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toBe('https://example.com/existing.xml\nhttps://example.org/imported.xml')
      expect(getByText('已从 subscriptions.opml 导入 2 个订阅地址')).toBeTruthy()
    })
    expect(addFeed).not.toHaveBeenCalled()
  })

  it('adds multiple subscriptions from the source pane and keeps failed URLs for retry', async () => {
    let failSecond = true
    const addFeed = vi.fn(async (url: string) => {
      if (url.includes('second') && failSecond) {
        failSecond = false
        throw new Error('Feed unavailable')
      }
      return {
        id: url, url, title: url.includes('second') ? 'Second feed' : 'First feed',
        createdAt: 1, updatedAt: 1, unreadCount: 0,
      } as RssFeed
    })
    const agentSnapshot = { running: false, messages: [], workspaces: [], sessions: [], models: [], modelBusy: false } as const
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: { getSnapshot: () => agentSnapshot, subscribe: () => () => {} },
      close: () => {}, listFeeds: async () => [], listArticles: async () => ({ articles: [], total: 0 }), addFeed,
    } as unknown as RssPanelProps

    const { container, getByRole, getByText, queryByRole } = render(<RssPanel {...props} />)
    expect(container.querySelector('.dsh-rss-top-actions')?.textContent).toBe('')
    fireEvent.click(container.querySelector('button[title="添加订阅"]')!)
    const input = getByRole('textbox', { name: '订阅地址' })
    fireEvent.change(input, { target: { value: 'https://example.com/first.xml\nhttps://example.com/second.xml\nhttps://example.com/first.xml' } })
    fireEvent.click(getByRole('button', { name: '添加全部' }))

    await waitFor(() => {
      expect(addFeed).toHaveBeenCalledTimes(2)
      expect(getByText('Feed unavailable')).toBeTruthy()
    })
    expect((input as HTMLTextAreaElement).value).toBe('https://example.com/second.xml')
    expect(queryByRole('dialog', { name: '添加 RSS 订阅' })).not.toBeNull()

    fireEvent.click(getByRole('button', { name: '添加全部' }))
    await waitFor(() => {
      expect(addFeed).toHaveBeenCalledTimes(3)
      expect(queryByRole('dialog', { name: '添加 RSS 订阅' })).toBeNull()
    })
  })

  it('adds an article to the Agent composer by button or drag and submits its context', async () => {
    const article = {
      id: 'article-1', feedId: 'feed-1', feedTitle: 'Test feed', guid: 'one',
      url: 'https://example.com/article', title: 'Article for Agent', summary: 'Short summary',
      content: 'Body', createdAt: 1, read: false, favorite: false,
    } as unknown as RssArticle
    const promptCurrent = vi.fn(async () => ({ ok: true as const }))
    const agentSnapshot = {
      sessionId: 'session-1', sessionTitle: 'Current', running: false, messages: [],
      workspaceId: 'workspace-1', workspaces: [{ id: 'workspace-1', title: 'Alpha', path: 'D:/alpha' }],
      sessions: [{ id: 'session-1', title: 'Current', workspaceId: 'workspace-1' }], models: [], modelBusy: false,
    } as const
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: {
        getSnapshot: () => agentSnapshot,
        subscribe: () => () => {},
      },
      close: () => {}, listFeeds: async () => [],
      listArticles: async () => ({ articles: [article], total: 1 }),
      getArticle: async () => article, setRead: async () => ({ changed: true }), promptCurrent,
    } as unknown as RssPanelProps

    const { container, getByRole, getByText } = render(<RssPanel {...props} />)
    await waitFor(() => { expect(container.querySelector('.dsh-rss-article-row')).not.toBeNull() })

    fireEvent.click(getByRole('button', { name: '添加“Article for Agent”到 Agent' }))
    expect(getByRole('button', { name: '添加“Article for Agent”到 Agent' }).textContent).toBe('')
    expect(getByText('已添加文章')).toBeTruthy()
    expect(container.querySelector('.dsh-rss-agent-attachment')?.textContent).toContain('Article for Agent')

    fireEvent.click(getByRole('button', { name: '移除已添加文章' }))
    const values = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none', dropEffect: 'none', types: [] as string[],
      setData(type: string, value: string) { values.set(type, value); if (!this.types.includes(type)) this.types.push(type) },
      getData(type: string) { return values.get(type) ?? '' },
    }
    fireEvent.dragStart(container.querySelector('.dsh-rss-article-row')!, { dataTransfer })
    fireEvent.dragOver(container.querySelector('.dsh-rss-agent-composer')!, { dataTransfer })
    expect(container.querySelector('.dsh-rss-agent-composer')?.hasAttribute('data-drop-active')).toBe(true)
    fireEvent.drop(container.querySelector('.dsh-rss-agent-composer')!, { dataTransfer })
    expect(container.querySelector('.dsh-rss-agent-attachment')?.textContent).toContain('Article for Agent')

    fireEvent.change(container.querySelector('.dsh-rss-agent-composer textarea')!, { target: { value: '请总结这篇文章' } })
    fireEvent.click(getByRole('button', { name: '发送' }))
    await waitFor(() => {
      expect(promptCurrent).toHaveBeenCalledWith(expect.stringContaining('articleId: article-1'))
      expect(promptCurrent).toHaveBeenCalledWith(expect.stringContaining('请总结这篇文章'))
    })
    await waitFor(() => { expect(container.querySelector('.dsh-rss-agent-attachment')).toBeNull() })

    fireEvent.click(container.querySelector('.dsh-rss-article-row')!)
    await waitFor(() => { expect(container.querySelector('.dsh-rss-reader h1')?.textContent).toBe('Article for Agent') })
    fireEvent.change(container.querySelector('.dsh-rss-agent-composer textarea')!, { target: { value: '普通问题' } })
    fireEvent.click(getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(promptCurrent).toHaveBeenLastCalledWith('普通问题') })
  })

  it('synchronizes read and favorite state while preserving the active feed scope', async () => {
    const feed = {
      id: 'feed-1', url: 'https://example.com/feed.xml', title: 'Test feed',
      createdAt: 1, updatedAt: 1, unreadCount: 1,
    } as unknown as RssFeed
    let serverArticle = {
      id: 'article-1', feedId: feed.id, feedTitle: feed.title, guid: 'one',
      title: 'Unread article', content: 'body', createdAt: 1, read: false, favorite: false,
    } as RssArticle
    const listArticles = vi.fn(async (filters: { feedId?: string; unreadOnly?: boolean; favoriteOnly?: boolean }) => {
      const articles = [serverArticle].filter(article =>
        (filters.feedId === undefined || article.feedId === filters.feedId)
        && (!filters.unreadOnly || !article.read)
        && (!filters.favoriteOnly || article.favorite))
      return { articles, total: articles.length }
    })
    const setRead = vi.fn(async (_id: string, read: boolean) => {
      serverArticle = { ...serverArticle, read }
      return { changed: true }
    })
    const setFavorite = vi.fn(async (_id: string, favorite: boolean) => {
      serverArticle = { ...serverArticle, favorite }
      return { changed: true }
    })
    const agentSnapshot = { running: false, messages: [], workspaces: [], sessions: [], models: [], modelBusy: false } as const
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: { getSnapshot: () => agentSnapshot, subscribe: () => () => {} },
      close: () => {}, listFeeds: async () => [{ ...feed, unreadCount: serverArticle.read ? 0 : 1 }], listArticles,
      getArticle: async () => serverArticle, setRead, setFavorite,
    } as unknown as RssPanelProps

    const { container } = render(<RssPanel {...props} />)
    await waitFor(() => { expect(container.querySelector('.dsh-rss-article-row')).not.toBeNull() })

    fireEvent.click(container.querySelector('.dsh-rss-article-row')!)
    await waitFor(() => { expect(setRead).toHaveBeenCalledWith('article-1', true) })
    expect(container.querySelector('.dsh-rss-article-meta b')).toBeNull()
    expect(container.querySelector('.dsh-rss-feed-main small')?.textContent).toContain('0 篇未读')

    fireEvent.click(container.querySelector('.dsh-rss-star')!)
    await waitFor(() => { expect(setFavorite).toHaveBeenCalledWith('article-1', true) })
    expect(container.querySelector('.dsh-rss-star')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.dsh-rss-reader-star')?.getAttribute('aria-pressed')).toBe('true')

    const railButtons = container.querySelectorAll('.dsh-rss-rail nav button')
    fireEvent.click(railButtons[1]!)
    await waitFor(() => {
      expect(listArticles.mock.calls.at(-1)?.[0]).toMatchObject({ favoriteOnly: true })
    })
    fireEvent.click(container.querySelector('.dsh-rss-feed-main')!)
    await waitFor(() => {
      expect(listArticles.mock.calls.at(-1)?.[0]).toMatchObject({ feedId: 'feed-1', favoriteOnly: true })
    })
    expect(railButtons[0]?.hasAttribute('data-active')).toBe(false)
    expect(railButtons[1]?.hasAttribute('data-active')).toBe(true)

    fireEvent.click(container.querySelector('.dsh-rss-star')!)
    await waitFor(() => { expect(setFavorite).toHaveBeenLastCalledWith('article-1', false) })
    await waitFor(() => { expect(container.querySelector('.dsh-rss-article-row')).toBeNull() })
  })

  it('controls the current Harness workspace, session, model, and reasoning effort', async () => {
    const startSession = vi.fn()
    const createWorkspace = vi.fn(async () => ({ ok: true as const, workspaceId: 'workspace-3' }))
    const openSession = vi.fn()
    const selectModel = vi.fn(async () => ({ ok: true as const }))
    const selectReasoningEffort = vi.fn(async () => ({ ok: true as const }))
    const agentSnapshot = {
      sessionId: 'session-1', sessionTitle: 'Current', running: false, messages: [],
      workspaceId: 'workspace-1', recentWorkspaceId: 'workspace-1', modelProvider: 'provider-1', modelId: 'model-1',
      reasoningEffort: 'medium', modelBusy: false,
      workspaces: [
        { id: 'workspace-1', title: 'Alpha', path: 'D:/alpha' },
        { id: 'workspace-2', title: 'Beta', path: 'D:/beta' },
      ],
      sessions: [
        { id: 'session-1', title: 'Current', workspaceId: 'workspace-1', workspaceTitle: 'Alpha' },
        { id: 'session-2', title: 'Second', workspaceId: 'workspace-2', workspaceTitle: 'Beta' },
      ],
      models: [{
        provider: 'provider-1', providerName: 'Provider One', id: 'model-1', name: 'Model One', defaultReasoningEffort: 'medium',
        reasoningEfforts: [{ id: 'medium', name: '中等' }, { id: 'high', name: '高' }],
      }, {
        provider: 'provider-2', providerName: 'Provider Two', id: 'model-2', name: 'Model Two', reasoningEfforts: [],
      }],
    } as const
    const props = {
      useRssUi: (select: (snapshot: { open: boolean }) => unknown) => select({ open: true }),
      agent: {
        getSnapshot: () => agentSnapshot, subscribe: () => () => {},
        createWorkspace, startSession, openSession, selectModel, selectReasoningEffort,
      },
      close: () => {}, listFeeds: async () => [], listArticles: async () => ({ articles: [], total: 0 }),
    } as unknown as RssPanelProps

    const { container, getByRole, queryByRole } = render(<RssPanel {...props} />)
    fireEvent.click(container.querySelector('.dsh-rss-agent-launcher')!)
    expect(container.querySelector('.dsh-rss-agent-float')?.getAttribute('style')).toContain('width: 430px')
    expect(container.querySelector('.dsh-rss-agent-model-row')).not.toBeNull()
    expect(getByRole('separator', { name: '调整 Agent 大小' })).toBeTruthy()
    expect(RSS_STYLE).toContain('resize:both')
    expect(RSS_STYLE).toContain('grid-template-columns:minmax(0,1fr) minmax(112px,.38fr)')
    expect(getByRole('option', { name: 'Provider One · Model One' })).toBeTruthy()
    expect(getByRole('option', { name: 'Provider Two · Model Two' })).toBeTruthy()
    expect(getByRole('option', { name: 'Current' })).toBeTruthy()
    expect(queryByRole('option', { name: 'Second' })).toBeNull()
    expect(queryByRole('option', { name: '未选择工作区' })).toBeNull()
    expect(getByRole('button', { name: '新建工作区' }).textContent).toBe('')
    expect(getByRole('button', { name: '新建会话' }).textContent).toBe('')
    fireEvent.click(getByRole('button', { name: '新建工作区' }))
    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledTimes(1)
      expect(startSession).toHaveBeenCalledWith('workspace-3')
    })
    fireEvent.change(getByRole('combobox', { name: '选择工作区' }), { target: { value: 'workspace-2' } })
    expect(queryByRole('option', { name: 'Current' })).toBeNull()
    expect(getByRole('option', { name: 'Second' })).toBeTruthy()
    fireEvent.click(getByRole('button', { name: '新建会话' }))
    expect(startSession).toHaveBeenCalledWith('workspace-2')
    fireEvent.change(getByRole('combobox', { name: '选择会话' }), { target: { value: 'session-2' } })
    expect(openSession).toHaveBeenCalledWith('session-2')
    fireEvent.change(getByRole('combobox', { name: '选择模型' }), { target: { value: 'provider-2/model-2' } })
    await waitFor(() => { expect(selectModel).toHaveBeenCalledWith('provider-2', 'model-2') })
    fireEvent.change(getByRole('combobox', { name: '选择思考等级' }), { target: { value: 'high' } })
    await waitFor(() => { expect(selectReasoningEffort).toHaveBeenCalledWith('high') })
  })

  it('switches the Agent header and transcript with the current Harness session', async () => {
    const first: RssAgentSnapshot = {
      sessionId: 'session-1', sessionTitle: 'First conversation', running: false,
      messages: [{ id: 'first-message', role: 'user', text: 'First message' }],
      workspaceId: 'workspace-1', workspaces: [{ id: 'workspace-1', title: 'Alpha', path: 'D:/alpha' }], sessions: [
        { id: 'session-1', title: 'First conversation', workspaceId: 'workspace-1' },
        { id: 'session-2', title: 'Second conversation', workspaceId: 'workspace-1' },
      ], models: [], modelBusy: false,
    }
    const second: RssAgentSnapshot = {
      ...first, sessionId: 'session-2', sessionTitle: 'Second conversation',
      messages: [{ id: 'second-message', role: 'assistant', text: 'Second message' }],
    }
    let snapshot = first
    const listeners = new Set<() => void>()
    const openSession = vi.fn((sessionId: string) => {
      snapshot = sessionId === 'session-2' ? second : first
      for (const listener of listeners) listener()
    })
    const props = {
      useRssUi: (select: (state: { open: boolean }) => unknown) => select({ open: true }),
      agent: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        openSession,
      },
      close: () => {}, listFeeds: async () => [], listArticles: async () => ({ articles: [], total: 0 }),
    } as unknown as RssPanelProps

    const { container, getByRole } = render(<RssPanel {...props} />)
    fireEvent.click(container.querySelector('.dsh-rss-agent-launcher')!)
    expect(container.querySelector('.dsh-rss-agent-title small')?.textContent).toContain('First conversation')
    expect(container.querySelector('.dsh-rss-agent-messages')?.textContent).toContain('First message')

    fireEvent.change(getByRole('combobox', { name: '选择会话' }), { target: { value: 'session-2' } })

    await waitFor(() => {
      expect(container.querySelector('.dsh-rss-agent-title small')?.textContent).toContain('Second conversation')
      expect(container.querySelector('.dsh-rss-agent-messages')?.textContent).toContain('Second message')
      expect(container.querySelector('.dsh-rss-agent-messages')?.textContent).not.toContain('First message')
    })
  })
})
