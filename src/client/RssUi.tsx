/** Full-screen RSS reader adapted from the Reader application's primary workspace. */

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type DragEvent as ReactDragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  FishLogo, IconAgentPresetOutline16, IconArchiveOutline20, IconBrowseOutline16,
  IconChevronDownOutline14, IconChevronLeftOutline14, IconChevronUpOutline14, IconCloseOutline16, IconGlobeOutline14, IconListPenOutline16, IconLoadingOutline16,
  IconNewChatOutline16, IconPaperclipOutline16, IconPlusOutline16, IconProjectAddOutline16, IconRefreshOutline14, IconRightUpOutline14, IconSearchOutline16,
  IconSendOutline16, IconTrashOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { RssArticle, RssArticlePage, RssFeed, RssRefreshResult } from '../types.ts'
import type { RssUiSnapshot } from './store.ts'

/** Browser-safe article filters accepted by the RSS RPC. */
export interface RssArticleFilters {
  readonly query?: string
  readonly feedId?: string
  readonly unreadOnly?: boolean
  readonly favoriteOnly?: boolean
  readonly limit?: number
  readonly offset?: number
}

/** One current-session message shown in the compact RSS Agent window. */
export interface RssAgentMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly pending?: boolean
}

/** Current Harness conversation facts needed by the RSS Agent window. */
export interface RssAgentSnapshot {
  readonly sessionId?: string
  readonly sessionTitle?: string
  readonly running: boolean
  readonly messages: readonly RssAgentMessage[]
  readonly workspaceId?: string
  readonly recentWorkspaceId?: string
  readonly workspaces: readonly { readonly id: string; readonly title: string; readonly path: string }[]
  readonly sessions: readonly {
    readonly id: string
    readonly title: string
    readonly workspaceId?: string
    readonly workspaceTitle?: string
  }[]
  readonly modelProvider?: string
  readonly modelId?: string
  readonly reasoningEffort?: string
  readonly models: readonly {
    readonly provider: string
    readonly providerName: string
    readonly id: string
    readonly name: string
    readonly reasoningEfforts: readonly { readonly id: string; readonly name: string }[]
    readonly defaultReasoningEffort?: string
  }[]
  readonly modelBusy: boolean
}

/** Observable current-session projection owned by the RSS client plugin. */
export interface RssAgentSource {
  getSnapshot(): RssAgentSnapshot
  subscribe(listener: () => void): () => void
  createWorkspace(): Promise<{ ok: true; workspaceId?: string } | { ok: false; message: string }>
  startSession(workspaceId?: string): void
  openSession(sessionId: string): void
  selectModel(provider: string, model: string): Promise<{ ok: true } | { ok: false; message: string }>
  selectReasoningEffort(effort?: string): Promise<{ ok: true } | { ok: false; message: string }>
}

/** RPC and current-session Agent operations injected into RSS components. */
export interface RssUiFace {
  hooks: { rssUi: { getSnapshot(): RssUiSnapshot; subscribe(listener: () => void): () => void } }
  agent: RssAgentSource
  toggle(): void
  close(): void
  listFeeds(signal?: AbortSignal): Promise<readonly RssFeed[]>
  reorderFeeds(ids: readonly string[], signal?: AbortSignal): Promise<{ readonly reordered: true }>
  addFeed(url: string, signal?: AbortSignal): Promise<RssFeed>
  removeFeed(id: string, signal?: AbortSignal): Promise<{ removed: boolean }>
  refreshFeed(id: string, signal?: AbortSignal): Promise<RssRefreshResult>
  refreshAll(signal?: AbortSignal): Promise<readonly RssRefreshResult[]>
  listArticles(filters: RssArticleFilters, signal?: AbortSignal): Promise<RssArticlePage>
  getArticle(id: string, signal?: AbortSignal): Promise<RssArticle>
  setRead(id: string, read: boolean, signal?: AbortSignal): Promise<{ changed: boolean }>
  setFavorite(id: string, favorite: boolean, signal?: AbortSignal): Promise<{ changed: boolean }>
  promptCurrent(text: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export type RssTriggerProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<RssUiFace>
export type RssPanelProps = PropsRuntime<'shell.overlay'> & InjectFace<RssUiFace>

/** Render the RSS action in the Harness sidebar footer. */
export function RssTrigger({ wide, useRssUi, toggle }: RssTriggerProps) {
  const open = useRssUi(state => state.open)
  const button = (
    <button type="button" className="dsh-rss-trigger" data-wide={wide} data-active={open || undefined} aria-label="RSS 阅读器" aria-pressed={open} onClick={toggle}>
      <IconGlobeOutline14 size={wide ? 16 : 18} />
      {wide && <span>RSS 阅读器</span>}
    </button>
  )
  return wide ? button : <Tooltip label="RSS 阅读器" delayMs={500}>{button}</Tooltip>
}

type View = 'all' | 'favorites'
type MobilePane = 'sources' | 'articles' | 'detail'
interface AgentPosition { readonly left: number; readonly top: number }
interface AgentSize { readonly width: number; readonly height: number }
interface FeedAddResult {
  readonly url: string
  readonly ok: boolean
  readonly message: string
}
interface AgentDragState {
  readonly pointerId: number
  readonly offsetX: number
  readonly offsetY: number
  readonly width: number
  readonly height: number
  readonly originX: number
  readonly originY: number
}
interface AgentResizeState {
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
  readonly left: number
  readonly top: number
  readonly minWidth: number
  readonly minHeight: number
}

const AGENT_VIEWPORT_MARGIN = 12
const RSS_ARTICLE_DRAG_TYPE = 'application/x-dsh-rss-article'

/** Extract unique subscription URLs from an OPML document. */
export function parseOpmlFeedUrls(source: string): readonly string[] {
  const document = new DOMParser().parseFromString(source, 'application/xml')
  if (document.querySelector('parsererror') !== null || document.documentElement.localName.toLocaleLowerCase() !== 'opml') {
    throw new Error('OPML 文件格式无效')
  }
  const urls = [...document.getElementsByTagName('outline')]
    .map(outline => (outline.getAttribute('xmlUrl') ?? outline.getAttribute('xmlurl') ?? '').trim())
    .filter(url => url !== '')
  const unique = [...new Set(urls)]
  if (unique.length === 0) throw new Error('OPML 文件中没有订阅地址')
  return unique
}

function clampAgentPosition(left: number, top: number, width: number, height: number): AgentPosition {
  return {
    left: Math.min(Math.max(AGENT_VIEWPORT_MARGIN, left), Math.max(AGENT_VIEWPORT_MARGIN, window.innerWidth - width - AGENT_VIEWPORT_MARGIN)),
    top: Math.min(Math.max(AGENT_VIEWPORT_MARGIN, top), Math.max(AGENT_VIEWPORT_MARGIN, window.innerHeight - height - AGENT_VIEWPORT_MARGIN)),
  }
}

/** Render the Reader-derived source, article-list, and reading workspace. */
export function RssPanel(props: RssPanelProps) {
  const open = props.useRssUi(state => state.open)
  const [feeds, setFeeds] = useState<readonly RssFeed[]>([])
  const [page, setPage] = useState<RssArticlePage>({ articles: [], total: 0 })
  const [selected, setSelected] = useState<RssArticle>()
  const [selectedFeedId, setSelectedFeedId] = useState<string>()
  const [view, setView] = useState<View>('all')
  const [mobilePane, setMobilePane] = useState<MobilePane>('articles')
  const [query, setQuery] = useState('')
  const [feedQuery, setFeedQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [reorderOpen, setReorderOpen] = useState(false)
  const [feedUrls, setFeedUrls] = useState('')
  const [feedAddResults, setFeedAddResults] = useState<readonly FeedAddResult[]>([])
  const [opmlSummary, setOpmlSummary] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentPosition, setAgentPosition] = useState<AgentPosition>()
  const [agentSize, setAgentSize] = useState<AgentSize>()
  const [agentDraft, setAgentDraft] = useState('')
  const [agentAttachment, setAgentAttachment] = useState<RssArticle>()
  const [agentDropActive, setAgentDropActive] = useState(false)
  const [agentSending, setAgentSending] = useState(false)
  const [agentCreatingWorkspace, setAgentCreatingWorkspace] = useState(false)
  const [agentWorkspaceId, setAgentWorkspaceId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const agentSnapshot = useSyncExternalStore(props.agent.subscribe, props.agent.getSnapshot, props.agent.getSnapshot)
  const agentScrollRef = useRef<HTMLDivElement>(null)
  const agentFloatRef = useRef<HTMLElement>(null)
  const agentLauncherRef = useRef<HTMLButtonElement>(null)
  const agentDragRef = useRef<AgentDragState>()
  const agentResizeRef = useRef<AgentResizeState>()
  const agentDragMovedRef = useRef(false)
  const readPendingRef = useRef(new Set<string>())
  const favoritePendingRef = useRef(new Set<string>())
  const selectedAgentModel = agentSnapshot.models.find(model =>
    model.provider === agentSnapshot.modelProvider && model.id === agentSnapshot.modelId)
  const effectiveReasoningEffort = agentSnapshot.reasoningEffort ?? selectedAgentModel?.defaultReasoningEffort ?? ''
  const visibleAgentSessions = useMemo(() => agentWorkspaceId === '' ? [] : agentSnapshot.sessions.filter(session =>
    session.workspaceId === agentWorkspaceId), [agentSnapshot.sessions, agentWorkspaceId])
  const visibleAgentSessionId = visibleAgentSessions.some(session => session.id === agentSnapshot.sessionId)
    ? agentSnapshot.sessionId
    : ''
  const agentReady = agentWorkspaceId !== '' && visibleAgentSessionId !== ''

  useEffect(() => {
    setAgentWorkspaceId(current => {
      const currentStillExists = agentSnapshot.workspaces.some(workspace => workspace.id === current)
      return agentSnapshot.workspaceId
        ?? (currentStillExists ? current : undefined)
        ?? agentSnapshot.recentWorkspaceId
        ?? agentSnapshot.workspaces[0]?.id
        ?? ''
    })
  }, [agentSnapshot.sessionId, agentSnapshot.workspaceId, agentSnapshot.recentWorkspaceId, agentSnapshot.workspaces])

  const beginAgentDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    const interactive = (event.target as HTMLElement).closest('button, a, input, textarea')
    if (interactive !== null && interactive !== event.currentTarget) return
    const surface = event.currentTarget.closest('.dsh-rss-agent-float') ?? event.currentTarget
    const bounds = surface.getBoundingClientRect()
    agentDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
      originX: event.clientX,
      originY: event.clientY,
    }
    agentDragMovedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveAgent = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = agentDragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    if (Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) > 3) agentDragMovedRef.current = true
    setAgentPosition(clampAgentPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY, drag.width, drag.height))
  }
  const endAgentDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (agentDragRef.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    agentDragRef.current = undefined
  }
  const beginAgentResize = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    const element = agentFloatRef.current
    if (element === null) return
    const bounds = element.getBoundingClientRect()
    const styles = getComputedStyle(element)
    agentResizeRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
      minWidth: Number.parseFloat(styles.minWidth) || 360,
      minHeight: Number.parseFloat(styles.minHeight) || 360,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }
  const resizeAgent = (event: ReactPointerEvent<HTMLElement>): void => {
    const resize = agentResizeRef.current
    if (resize === undefined || resize.pointerId !== event.pointerId) return
    setAgentSize({
      width: Math.min(Math.max(resize.minWidth, resize.width + event.clientX - resize.originX), window.innerWidth - resize.left - AGENT_VIEWPORT_MARGIN),
      height: Math.min(Math.max(resize.minHeight, resize.height + event.clientY - resize.originY), window.innerHeight - resize.top - AGENT_VIEWPORT_MARGIN),
    })
  }
  const endAgentResize = (event: ReactPointerEvent<HTMLElement>): void => {
    if (agentResizeRef.current?.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    agentResizeRef.current = undefined
  }
  const resizeAgentWithKeyboard = (event: KeyboardEvent<HTMLElement>): void => {
    const delta = 24
    const widthDelta = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
    const heightDelta = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
    if (widthDelta === 0 && heightDelta === 0) return
    const element = agentFloatRef.current
    if (element === null) return
    const bounds = element.getBoundingClientRect()
    const styles = getComputedStyle(element)
    setAgentSize({
      width: Math.min(Math.max(Number.parseFloat(styles.minWidth) || 360, bounds.width + widthDelta), window.innerWidth - bounds.left - AGENT_VIEWPORT_MARGIN),
      height: Math.min(Math.max(Number.parseFloat(styles.minHeight) || 360, bounds.height + heightDelta), window.innerHeight - bounds.top - AGENT_VIEWPORT_MARGIN),
    })
    event.preventDefault()
  }
  const openAgent = (): void => {
    const bounds = agentLauncherRef.current?.getBoundingClientRect()
    if (bounds !== undefined) {
      const compact = window.innerWidth <= 820
      const width = Math.min(agentSize?.width ?? (compact ? window.innerWidth - AGENT_VIEWPORT_MARGIN * 2 : 430), window.innerWidth - AGENT_VIEWPORT_MARGIN * 2)
      const height = Math.min(agentSize?.height ?? (compact ? Math.min(620, window.innerHeight - 154) : 640), window.innerHeight - AGENT_VIEWPORT_MARGIN * 2)
      setAgentSize({ width, height })
      setAgentPosition(clampAgentPosition(bounds.right - width, bounds.bottom - height, width, height))
    }
    setAgentOpen(true)
  }
  const collapseAgent = (): void => {
    const bounds = agentFloatRef.current?.getBoundingClientRect()
    if (bounds !== undefined) {
      setAgentSize({ width: bounds.width, height: bounds.height })
      setAgentPosition(clampAgentPosition(bounds.right - 105, bounds.bottom - 48, 105, 48))
    }
    setAgentOpen(false)
  }
  const attachArticleToAgent = (article: RssArticle): void => {
    setAgentAttachment(article)
    openAgent()
  }
  const beginArticleDrag = (event: ReactDragEvent<HTMLElement>, article: RssArticle): void => {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(RSS_ARTICLE_DRAG_TYPE, article.id)
    event.dataTransfer.setData('text/plain', `${article.title}\n${article.url ?? ''}`.trim())
  }
  const dragArticleOverComposer = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(RSS_ARTICLE_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setAgentDropActive(true)
  }
  const dropArticleOnComposer = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setAgentDropActive(false)
    const articleId = event.dataTransfer.getData(RSS_ARTICLE_DRAG_TYPE)
    const article = page.articles.find(item => item.id === articleId)
    if (article !== undefined) setAgentAttachment(article)
  }

  const loadFeeds = useCallback((signal?: AbortSignal): void => {
    void props.listFeeds(signal).then(setFeeds, caught => { if (!signal?.aborted) setError(messageOf(caught)) })
  }, [props.listFeeds])
  const loadArticles = useCallback((signal?: AbortSignal): void => {
    setLoading(true); setError(undefined)
    void props.listArticles({
      ...(query.trim() !== '' ? { query: query.trim() } : {}),
      ...(selectedFeedId !== undefined ? { feedId: selectedFeedId } : {}),
      ...(unreadOnly ? { unreadOnly: true } : {}),
      ...(view === 'favorites' ? { favoriteOnly: true } : {}),
      limit: 100, offset: 0,
    }, signal).then(value => {
      setPage(value)
      setLoading(false)
      setSelected(current => current !== undefined && !value.articles.some(article => article.id === current.id) ? undefined : current)
    }, caught => { if (!signal?.aborted) { setError(messageOf(caught)); setLoading(false) } })
  }, [props.listArticles, query, selectedFeedId, unreadOnly, view])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    loadFeeds(controller.signal)
    return () => { controller.abort() }
  }, [open, loadFeeds])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    loadArticles(controller.signal)
    return () => { controller.abort() }
  }, [open, loadArticles])
  useEffect(() => {
    if (notice === undefined) return
    const timer = window.setTimeout(() => { setNotice(undefined) }, 3200)
    return () => { window.clearTimeout(timer) }
  }, [notice])
  useEffect(() => {
    if (!agentOpen) return
    const element = agentScrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [agentOpen, agentSnapshot.messages])
  useEffect(() => {
    const keepAgentInViewport = (): void => {
      const element = agentOpen ? agentFloatRef.current : agentLauncherRef.current
      if (element === null || agentPosition === undefined) return
      const bounds = element.getBoundingClientRect()
      const next = clampAgentPosition(bounds.left, bounds.top, bounds.width, bounds.height)
      setAgentPosition(current => current?.left === next.left && current.top === next.top ? current : next)
    }
    window.addEventListener('resize', keepAgentInViewport)
    return () => { window.removeEventListener('resize', keepAgentInViewport) }
  }, [agentOpen, agentPosition])
  useEffect(() => {
    const element = agentFloatRef.current
    if (!agentOpen || element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect()
      const nextSize = { width: bounds.width, height: bounds.height }
      setAgentSize(current => current?.width === nextSize.width && current.height === nextSize.height ? current : nextSize)
      const nextPosition = clampAgentPosition(bounds.left, bounds.top, bounds.width, bounds.height)
      setAgentPosition(current => current?.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [agentOpen])

  const visibleFeeds = useMemo(() => {
    const term = feedQuery.trim().toLocaleLowerCase()
    return term === '' ? feeds : feeds.filter(feed => `${feed.title}\n${feed.url}`.toLocaleLowerCase().includes(term))
  }, [feeds, feedQuery])
  const unreadCount = feeds.reduce((sum, feed) => sum + feed.unreadCount, 0)

  const chooseView = (next: View): void => {
    setView(next); setSelectedFeedId(undefined); setSelected(undefined); setMobilePane('articles')
  }
  const chooseFeed = (id?: string): void => {
    setSelectedFeedId(id); setSelected(undefined); setMobilePane('articles')
  }
  const openArticle = (id: string): void => {
    setError(undefined)
    void props.getArticle(id).then(article => {
      const readPending = readPendingRef.current.has(id)
      setSelected(article.read || readPending ? article : { ...article, read: true }); setMobilePane('detail')
      if (article.read || readPending) return
      readPendingRef.current.add(id)
      setPage(current => {
        const containedUnread = current.articles.some(item => item.id === id && !item.read)
        return {
          ...current,
          articles: unreadOnly
            ? current.articles.filter(item => item.id !== id)
            : current.articles.map(item => item.id === id ? { ...item, read: true } : item),
          total: unreadOnly && containedUnread ? Math.max(0, current.total - 1) : current.total,
        }
      })
      setFeeds(current => current.map(feed => feed.id === article.feedId
        ? { ...feed, unreadCount: Math.max(0, feed.unreadCount - 1) }
        : feed))
      void props.setRead(id, true).then(result => {
        readPendingRef.current.delete(id)
        if (result.changed) { loadFeeds(); return }
        setSelected(current => current?.id === id ? article : current)
        setError('文章已不存在')
        loadFeeds(); loadArticles()
      }, caught => {
        readPendingRef.current.delete(id)
        setSelected(current => current?.id === id ? article : current)
        setError(messageOf(caught)); loadFeeds(); loadArticles()
      })
    }, caught => { setError(messageOf(caught)) })
  }
  const toggleFavorite = (article: RssArticle): void => {
    if (favoritePendingRef.current.has(article.id)) return
    const favorite = !article.favorite
    favoritePendingRef.current.add(article.id)
    const updateFavorite = (value: boolean): void => {
      setSelected(current => current?.id === article.id ? { ...current, favorite: value } : current)
      setPage(current => ({
        ...current,
        articles: current.articles.map(item => item.id === article.id ? { ...item, favorite: value } : item),
      }))
    }
    updateFavorite(favorite)
    void props.setFavorite(article.id, favorite).then(result => {
      favoritePendingRef.current.delete(article.id)
      if (!result.changed) {
        updateFavorite(!favorite); setError('文章已不存在'); loadArticles(); return
      }
      if (view === 'favorites' && !favorite) {
        setPage(current => {
          const contained = current.articles.some(item => item.id === article.id)
          return {
            ...current,
            articles: current.articles.filter(item => item.id !== article.id),
            total: contained ? Math.max(0, current.total - 1) : current.total,
          }
        })
      }
    }, caught => {
      favoritePendingRef.current.delete(article.id)
      updateFavorite(!favorite); setError(messageOf(caught))
      if (view === 'favorites') loadArticles()
    })
  }
  const sendAgentPrompt = (): void => {
    const question = agentDraft.trim()
    if (question === '' || agentSending || !agentReady) return
    setAgentSending(true); setError(undefined)
    const contextArticle = agentAttachment
    const articleContext = contextArticle === undefined
      ? ''
      : `我正在 RSS 阅读器中阅读“${contextArticle.title}”（articleId: ${contextArticle.id}${contextArticle.url === undefined ? '' : `，来源 ${contextArticle.url}`}）。请使用 rss_read_article 获取正文，并在引用文章内容时附上原文链接。\n\n`
    void props.promptCurrent(`${articleContext}${question}`).then(result => {
      setAgentSending(false)
      if (result.ok) { setAgentDraft(''); setAgentAttachment(undefined) }
      else setError(result.message)
    })
  }
  const selectAgentModel = (value: string): void => {
    const model = agentSnapshot.models.find(item => `${item.provider}/${item.id}` === value)
    if (model === undefined) return
    void props.agent.selectModel(model.provider, model.id).then(result => {
      if (!result.ok) setError(result.message)
    })
  }
  const selectAgentReasoning = (value: string): void => {
    void props.agent.selectReasoningEffort(value === '' ? undefined : value).then(result => {
      if (!result.ok) setError(result.message)
    })
  }
  const createAgentWorkspace = (): void => {
    if (agentCreatingWorkspace) return
    setAgentCreatingWorkspace(true)
    setError(undefined)
    void props.agent.createWorkspace().then(result => {
      setAgentCreatingWorkspace(false)
      if (!result.ok) { setError(result.message); return }
      if (result.workspaceId === undefined) return
      setAgentWorkspaceId(result.workspaceId)
      props.agent.startSession(result.workspaceId)
    })
  }
  const addFeeds = (): void => {
    const urls = [...new Set(feedUrls.split(/\r?\n/u).map(url => url.trim()).filter(url => url !== ''))]
    if (urls.length === 0 || busy) return
    setBusy(true); setError(undefined)
    setFeedAddResults([])
    void Promise.all(urls.map(async url => {
      try {
        const feed = await props.addFeed(url)
        return { url, ok: true, message: feed.title } satisfies FeedAddResult
      } catch (caught) {
        return { url, ok: false, message: messageOf(caught) } satisfies FeedAddResult
      }
    })).then(results => {
      const failed = results.filter(result => !result.ok)
      const added = results.length - failed.length
      setBusy(false)
      setFeedAddResults(results)
      if (added > 0) { loadFeeds(); loadArticles(); chooseFeed(undefined) }
      if (failed.length === 0) {
        setFeedUrls(''); setFeedAddResults([]); setAddOpen(false); setNotice(`已添加 ${String(added)} 个订阅源`)
        return
      }
      setFeedUrls(failed.map(result => result.url).join('\n'))
      setNotice(added === 0 ? `添加失败 ${String(failed.length)} 个` : `已添加 ${String(added)} 个，失败 ${String(failed.length)} 个`)
    })
  }
  const importOpmlFile = (file?: File): void => {
    if (file === undefined || busy) return
    setError(undefined)
    void file.text().then(source => {
      const imported = parseOpmlFeedUrls(source)
      const current = feedUrls.split(/\r?\n/u).map(url => url.trim()).filter(url => url !== '')
      setFeedUrls([...new Set([...current, ...imported])].join('\n'))
      setFeedAddResults([])
      setOpmlSummary(`已从 ${file.name} 导入 ${String(imported.length)} 个订阅地址`)
    }, caught => { setError(messageOf(caught)) }).catch(caught => { setError(messageOf(caught)) })
  }
  const refreshFeed = (feed: RssFeed): void => {
    if (busy) return
    setBusy(true); setError(undefined)
    void props.refreshFeed(feed.id).then(result => {
      setBusy(false); setNotice(`${result.title}：新增 ${String(result.inserted)} 篇`); loadFeeds(); loadArticles()
    }, caught => { setBusy(false); setError(messageOf(caught)); loadFeeds() })
  }
  const removeFeed = (feed: RssFeed): void => {
    if (!window.confirm(`确定删除“${feed.title}”吗？`)) return
    void props.removeFeed(feed.id).then(() => {
      if (selectedFeedId === feed.id) chooseFeed(undefined)
      setNotice('订阅已删除'); loadFeeds(); loadArticles()
    }, caught => { setError(messageOf(caught)) })
  }
  const refreshAll = (): void => {
    if (busy || feeds.length === 0) return
    setBusy(true); setError(undefined)
    void props.refreshAll().then(results => {
      setBusy(false); setNotice(`已刷新 ${String(results.length)} 个订阅源`); loadFeeds(); loadArticles()
    }, caught => { setBusy(false); setError(messageOf(caught)); loadFeeds() })
  }
  const saveFeedOrder = (ids: readonly string[]): void => {
    if (busy) return
    setBusy(true); setError(undefined)
    void props.reorderFeeds(ids).then(() => {
      setBusy(false); setReorderOpen(false); setNotice('订阅源顺序已保存'); loadFeeds()
    }, caught => { setBusy(false); setError(messageOf(caught)); loadFeeds() })
  }

  if (!open) return null
  const selectedFeed = feeds.find(feed => feed.id === selectedFeedId)
  return (
    <section className={`dsh-rss-app pane-${mobilePane}`} aria-label="RSS 阅读器">
      <header className="dsh-rss-topbar">
        <div className="dsh-rss-brand"><span className="dsh-rss-logo"><FishLogo size={28} /></span><strong>RSS 阅读器</strong></div>
        <label className="dsh-rss-global-search"><IconSearchOutline16 size={16} /><input value={query} placeholder="检索文章" aria-label="搜索 RSS 文章" onChange={event => { setQuery(event.target.value) }} /><kbd>⌘K</kbd></label>
        <div className="dsh-rss-top-actions"><button type="button" className="dsh-rss-icon-button" aria-label="关闭 RSS 阅读器" onClick={props.close}><IconCloseOutline16 size={18} /></button></div>
      </header>

      <main className="dsh-rss-workspace">
        <aside className="dsh-rss-rail" aria-label="阅读器导航">
          <nav><button type="button" data-active={view === 'all' && selectedFeedId === undefined || undefined} onClick={() => { chooseView('all') }}><span><IconBrowseOutline16 size={20} /></span><small>全部文章</small></button><button type="button" data-active={view === 'favorites' || undefined} onClick={() => { chooseView('favorites') }}><span><IconArchiveOutline20 size={20} /></span><small>收藏</small></button></nav>
          <button type="button" className="dsh-rss-rail-close" onClick={props.close}><span><IconChevronLeftOutline14 size={18} /></span><small>返回 Agent</small></button>
        </aside>

        <aside className="dsh-rss-sources">
          <div className="dsh-rss-pane-head"><strong>订阅源</strong><div><button type="button" title="全部刷新" disabled={busy || feeds.length === 0} onClick={refreshAll}><IconRefreshOutline14 size={15} /></button><button type="button" title="添加订阅" onClick={() => { setFeedAddResults([]); setOpmlSummary(undefined); setAddOpen(true) }}><IconPlusOutline16 size={16} /></button><button type="button" title="调整订阅源顺序" aria-label="调整订阅源顺序" disabled={busy || feeds.length < 2} onClick={() => { setReorderOpen(true) }}><IconListPenOutline16 size={16} /></button></div></div>
          <label className="dsh-rss-source-search"><IconSearchOutline16 size={14} /><input value={feedQuery} placeholder="搜索订阅源" onChange={event => { setFeedQuery(event.target.value) }} /></label>
          <button type="button" className="dsh-rss-source-all" data-active={selectedFeedId === undefined || undefined} onClick={() => { chooseFeed(undefined) }}><span>所有来源</span><small>{unreadCount}</small></button>
          <div className="dsh-rss-feed-list">
            {visibleFeeds.length === 0 && <Empty text="暂无订阅源" />}
            {visibleFeeds.map(feed => <div key={feed.id} className="dsh-rss-feed-item" data-active={selectedFeedId === feed.id || undefined}><button type="button" className="dsh-rss-feed-main" onClick={() => { chooseFeed(feed.id) }}><span className={`dsh-rss-status-dot${feed.error === undefined ? '' : ' error'}`} /><span><strong>{feed.title}</strong><small>{feed.unreadCount} 篇未读{feed.lastFetchedAt === undefined ? '' : ` · ${relativeTime(feed.lastFetchedAt)}`}</small>{feed.error !== undefined && <em>{feed.error}</em>}</span></button><div className="dsh-rss-feed-actions"><button type="button" title="刷新" disabled={busy} onClick={() => { refreshFeed(feed) }}><IconRefreshOutline14 size={14} /></button><button type="button" title="删除" onClick={() => { removeFeed(feed) }}><IconTrashOutline16 size={14} /></button></div></div>)}
          </div>
        </aside>

        <section className="dsh-rss-articles">
          <div className="dsh-rss-pane-head"><button type="button" className="dsh-rss-mobile-back" onClick={() => { setMobilePane('sources') }}><IconChevronLeftOutline14 size={14} />订阅源</button><strong>{selectedFeed?.title ?? (view === 'favorites' ? '收藏文章' : '全部文章')} <span>({page.total})</span></strong><button type="button" className="dsh-rss-filter" data-active={unreadOnly || undefined} onClick={() => { setUnreadOnly(value => !value) }}>{unreadOnly ? '仅未读' : '筛选未读'}</button></div>
          <div className="dsh-rss-article-list">
            {loading && <Empty text="正在加载文章…" loading />}
            {!loading && page.articles.length === 0 && <Empty text={feeds.length === 0 ? '请先添加订阅源' : '暂无文章'} />}
            {page.articles.map(article => <div key={article.id} role="button" tabIndex={0} draggable className="dsh-rss-article-row" data-active={selected?.id === article.id || undefined} data-read={article.read || undefined} title="可拖到 Agent 输入框" onDragStart={event => { beginArticleDrag(event, article) }} onClick={() => { openArticle(article.id) }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArticle(article.id) } }}><div className="dsh-rss-article-meta"><i data-read={article.read || undefined} /><span>{article.feedTitle}</span><time>{relativeTime(article.publishedAt ?? article.createdAt)}</time>{!article.read && <b>未读</b>}</div><strong>{article.title}</strong>{article.summary !== undefined && <p>{article.summary}</p>}<Tooltip label="添加到 Agent" side="top" delayMs={350}><button type="button" className="dsh-rss-agent-add" aria-label={`添加“${article.title}”到 Agent`} onClick={event => { event.stopPropagation(); attachArticleToAgent(article) }}><IconAgentPresetOutline16 size={15} /></button></Tooltip><button type="button" className="dsh-rss-star" data-active={article.favorite || undefined} aria-label={article.favorite ? '取消收藏' : '收藏'} aria-pressed={article.favorite} onClick={event => { event.stopPropagation(); toggleFavorite(article) }}><IconArchiveOutline20 size={17} /></button></div>)}
          </div>
        </section>

        <article className="dsh-rss-reader">
          {selected === undefined ? <Empty text="选择一篇文章开始阅读" /> : <><div className="dsh-rss-reader-actions"><button type="button" className="dsh-rss-mobile-back" onClick={() => { setMobilePane('articles') }}><IconChevronLeftOutline14 size={14} />文章列表</button>{selected.url !== undefined && <a href={selected.url} target="_blank" rel="noreferrer"><IconRightUpOutline14 size={14} />打开原文</a>}<button type="button" className="dsh-rss-reader-star" data-active={selected.favorite || undefined} aria-label={selected.favorite ? '取消收藏' : '收藏'} aria-pressed={selected.favorite} onClick={() => { toggleFavorite(selected) }}><IconArchiveOutline20 size={17} />{selected.favorite ? '已收藏' : '收藏'}</button></div><div className="dsh-rss-reader-scroll"><div className="dsh-rss-reader-content"><div className="dsh-rss-overline"><span>{selected.feedTitle}</span>{selected.author !== undefined && <small>{selected.author}</small>}<time>{new Date(selected.publishedAt ?? selected.createdAt).toLocaleDateString('zh-CN')}</time></div><h1>{selected.title}</h1><div className="dsh-rss-prose">{selected.content || selected.summary || 'Feed 没有提供正文。'}</div></div></div></>}
        </article>
      </main>

      {agentOpen
        ? <aside ref={agentFloatRef} className="dsh-rss-agent-float" aria-label="当前 Agent 会话" style={{ ...(agentPosition === undefined ? {} : { ...agentPosition, right: 'auto', bottom: 'auto' }), ...(agentSize === undefined ? {} : agentSize) }}>
            <header title="拖动标题栏移动，拖动右下角缩放" onPointerDown={beginAgentDrag} onPointerMove={moveAgent} onPointerUp={endAgentDrag} onPointerCancel={endAgentDrag}><div className="dsh-rss-agent-title"><span className="dsh-rss-agent-mark"><IconAgentPresetOutline16 size={17} /></span><span><strong>询问 Agent</strong><small>{agentSnapshot.sessionId === undefined ? '当前没有 Harness 会话' : `${agentSnapshot.sessionTitle ?? '当前会话'} · ${agentSnapshot.running ? '正在工作' : '标准模式'}`}</small></span></div><button type="button" aria-label="缩小 Agent" title="缩小" onClick={collapseAgent}><IconChevronDownOutline14 size={16} /></button></header>
            <div className="dsh-rss-agent-controls">
              <label className="dsh-rss-agent-workspace"><span>工作区</span><select aria-label="选择工作区" disabled={agentSnapshot.workspaces.length === 0 || agentCreatingWorkspace} value={agentWorkspaceId} onChange={event => { setAgentWorkspaceId(event.target.value) }}>{agentSnapshot.workspaces.length === 0 && <option value="">暂无工作区</option>}{agentSnapshot.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}</select></label>
              <Tooltip label={agentCreatingWorkspace ? '正在创建工作区' : '新建工作区'} side="top" delayMs={300}><button type="button" className="dsh-rss-agent-new-workspace" aria-label="新建工作区" data-loading={agentCreatingWorkspace || undefined} disabled={agentCreatingWorkspace} onClick={createAgentWorkspace}>{agentCreatingWorkspace ? <IconLoadingOutline16 size={15} /> : <IconProjectAddOutline16 size={16} />}</button></Tooltip>
              <label className="dsh-rss-agent-session"><span>会话</span><select aria-label="选择会话" disabled={visibleAgentSessions.length === 0 || agentCreatingWorkspace} value={visibleAgentSessionId} onChange={event => { if (event.target.value !== '') props.agent.openSession(event.target.value) }}><option value="">{visibleAgentSessions.length === 0 ? '该工作区暂无会话' : '选择会话'}</option>{visibleAgentSessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
              <Tooltip label="新建会话" side="top" delayMs={300}><button type="button" className="dsh-rss-agent-new-session" aria-label="新建会话" disabled={agentWorkspaceId === '' || agentCreatingWorkspace} onClick={() => { props.agent.startSession(agentWorkspaceId) }}><IconNewChatOutline16 size={16} /></button></Tooltip>
              <div className="dsh-rss-agent-model-row">
                <label className="dsh-rss-agent-model"><span>模型</span><select aria-label="选择模型" disabled={!agentReady || agentSnapshot.modelBusy || agentSnapshot.models.length === 0} value={agentSnapshot.modelProvider === undefined || agentSnapshot.modelId === undefined ? '' : `${agentSnapshot.modelProvider}/${agentSnapshot.modelId}`} onChange={event => { selectAgentModel(event.target.value) }}><option value="">选择模型</option>{agentSnapshot.models.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.providerName} · {model.name}</option>)}</select></label>
                <label className="dsh-rss-agent-reasoning"><span>思考等级</span><select aria-label="选择思考等级" disabled={!agentReady || agentSnapshot.modelBusy || selectedAgentModel === undefined || selectedAgentModel.reasoningEfforts.length === 0} value={effectiveReasoningEffort} onChange={event => { selectAgentReasoning(event.target.value) }}><option value="">默认</option>{selectedAgentModel?.reasoningEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}</select></label>
              </div>
            </div>
            <div ref={agentScrollRef} className="dsh-rss-agent-messages" aria-live="polite">
              {!agentReady && <div className="dsh-rss-agent-empty"><IconAgentPresetOutline16 size={22} /><strong>{agentSnapshot.workspaces.length === 0 ? '请先新建工作区' : '请选择工作区中的会话'}</strong><span>选定工作区和会话后才能向 Agent 提问。</span></div>}
              {agentReady && agentSnapshot.messages.length === 0 && <div className="dsh-rss-agent-empty"><IconAgentPresetOutline16 size={22} /><strong>向当前 Agent 提问</strong><span>点击文章的 Agent 按钮或拖入文章，才会附带文章上下文。</span></div>}
              {agentReady && agentSnapshot.messages.map(message => <div key={message.id} className="dsh-rss-agent-message" data-role={message.role} data-pending={message.pending || undefined}><small>{message.role === 'user' ? '你' : 'Agent'}{message.pending ? ' · 排队中' : ''}</small><p>{message.text}</p></div>)}
              {agentReady && agentSnapshot.running && <div className="dsh-rss-agent-working"><IconLoadingOutline16 size={14} /><span>Agent 正在处理…</span></div>}
            </div>
            <div className="dsh-rss-agent-composer" data-drop-active={agentDropActive || undefined} onDragEnter={dragArticleOverComposer} onDragOver={dragArticleOverComposer} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAgentDropActive(false) }} onDrop={dropArticleOnComposer}>{agentAttachment !== undefined && <div className="dsh-rss-agent-attachment"><span className="dsh-rss-agent-attachment-mark"><IconAgentPresetOutline16 size={14} /></span><span><small>已添加文章</small><strong>{agentAttachment.title}</strong><em>{agentAttachment.feedTitle}</em></span><button type="button" aria-label="移除已添加文章" onClick={() => { setAgentAttachment(undefined) }}><IconCloseOutline16 size={13} /></button></div>}<textarea value={agentDraft} disabled={!agentReady || agentSending} rows={3} placeholder={!agentReady ? '请先选择工作区和会话…' : agentAttachment !== undefined ? '针对已添加文章提问…' : '向当前 Agent 提问…'} onChange={event => { setAgentDraft(event.target.value) }} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAgentPrompt() } }} /><button type="button" aria-label="发送" data-sending={agentSending || undefined} disabled={!agentReady || agentDraft.trim() === '' || agentSending} onClick={sendAgentPrompt}>{agentSending ? <IconLoadingOutline16 size={16} /> : <IconSendOutline16 size={16} />}</button><small>{agentDropActive ? '松开即可添加文章' : '可拖入文章 · Enter 发送 · Shift + Enter 换行'}</small></div>
            <span className="dsh-rss-agent-resize-handle" role="separator" tabIndex={0} aria-label="调整 Agent 大小" title="拖动调整大小" onPointerDown={beginAgentResize} onPointerMove={resizeAgent} onPointerUp={endAgentResize} onPointerCancel={endAgentResize} onKeyDown={resizeAgentWithKeyboard} />
          </aside>
        : <button ref={agentLauncherRef} type="button" className="dsh-rss-agent-launcher" aria-label="展开 Agent" title="拖动或点击展开 Agent" style={agentPosition === undefined ? undefined : { ...agentPosition, right: 'auto', bottom: 'auto' }} onPointerDown={beginAgentDrag} onPointerMove={moveAgent} onPointerUp={endAgentDrag} onPointerCancel={endAgentDrag} onClick={() => { if (agentDragMovedRef.current) { agentDragMovedRef.current = false; return } openAgent() }}><span><IconAgentPresetOutline16 size={19} /></span><strong>Agent</strong>{agentSnapshot.running && <i />}</button>}

      {error !== undefined && <button type="button" className="dsh-rss-toast error" onClick={() => { setError(undefined) }}>{error}</button>}
      {notice !== undefined && <button type="button" className="dsh-rss-toast" onClick={() => { setNotice(undefined) }}>{notice}</button>}
      {reorderOpen && <FeedOrderDialog feeds={feeds} busy={busy} onClose={() => { if (!busy) setReorderOpen(false) }} onSave={saveFeedOrder} />}
      {addOpen && <div className="dsh-rss-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setAddOpen(false) }}><section className="dsh-rss-modal" role="dialog" aria-modal="true" aria-label="添加 RSS 订阅"><header><div><small>NEW SUBSCRIPTIONS</small><h2>添加订阅源</h2></div><button type="button" aria-label="关闭" disabled={busy} onClick={() => { setAddOpen(false) }}><IconCloseOutline16 size={16} /></button></header><p>每行输入一个 RSS 或 Atom 地址，也可以从 OPML 文件导入。确认后会同时抓取并保存最新文章。</p><div className="dsh-rss-opml-import"><label><IconPaperclipOutline16 size={15} /><span>导入 OPML</span><input type="file" accept=".opml,.xml,text/x-opml,text/xml,application/xml" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; importOpmlFile(file) }} /></label><small>支持 .opml 和 .xml 文件</small>{opmlSummary !== undefined && <strong aria-live="polite">{opmlSummary}</strong>}</div><label>订阅地址<textarea autoFocus rows={6} value={feedUrls} disabled={busy} placeholder={'https://example.com/feed.xml\nhttps://example.org/atom.xml'} onChange={event => { setFeedUrls(event.target.value); setFeedAddResults([]); setOpmlSummary(undefined) }} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); addFeeds() } }} /></label>{feedAddResults.length > 0 && <div className="dsh-rss-add-results" aria-live="polite">{feedAddResults.map(result => <div key={result.url} data-ok={result.ok || undefined}><strong>{result.ok ? '已添加' : '失败'}</strong><span>{result.url}</span><small>{result.message}</small></div>)}</div>}<footer><span>Ctrl/⌘ + Enter 添加</span><button type="button" onClick={() => { setAddOpen(false) }} disabled={busy}>取消</button><button type="button" className="dsh-rss-primary" disabled={busy || feedUrls.trim() === ''} onClick={addFeeds}>{busy ? '正在添加…' : '添加全部'}</button></footer></section></div>}
    </section>
  )
}

function Empty({ text, loading = false }: { text: string; loading?: boolean }) {
  return <div className="dsh-rss-empty">{loading && <i />}<span>{text}</span></div>
}

function FeedOrderDialog({ feeds, busy, onClose, onSave }: {
  readonly feeds: readonly RssFeed[]
  readonly busy: boolean
  readonly onClose: () => void
  readonly onSave: (ids: readonly string[]) => void
}) {
  const [items, setItems] = useState(() => [...feeds])
  const dragIndexRef = useRef<number>()
  const [dragIndex, setDragIndex] = useState<number>()
  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= items.length) return
    setItems(current => {
      const next = [...current]
      const [moved] = next.splice(from, 1)
      if (moved !== undefined) next.splice(to, 0, moved)
      return next
    })
    dragIndexRef.current = to
    setDragIndex(to)
  }
  return <div className="dsh-rss-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="dsh-rss-modal dsh-rss-reorder-modal" role="dialog" aria-modal="true" aria-label="调整订阅源顺序"><header><div><small>SUBSCRIPTION ORDER</small><h2>调整订阅源顺序</h2></div><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}><IconCloseOutline16 size={16} /></button></header><p>拖动订阅源进行排序，也可以使用每行右侧的上下按钮。保存后会在下次启动时继续使用此顺序。</p><div className="dsh-rss-reorder-list" onDragOver={event => { event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientY < bounds.top + 48) event.currentTarget.scrollTop -= 12; else if (event.clientY > bounds.bottom - 48) event.currentTarget.scrollTop += 12 }}>
    {items.map((feed, index) => <div key={feed.id} className="dsh-rss-reorder-row" data-dragging={dragIndex === index || undefined} draggable={!busy} onDragStart={event => { dragIndexRef.current = index; setDragIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', feed.id) }} onDragEnter={() => { const from = dragIndexRef.current; if (from !== undefined) move(from, index) }} onDragOver={event => { event.preventDefault() }} onDragEnd={() => { dragIndexRef.current = undefined; setDragIndex(undefined) }}><span>{String(index + 1)}</span><strong title={feed.title}>{feed.title}</strong><small>{feed.unreadCount} 篇未读</small><div><button type="button" aria-label={`上移 ${feed.title}`} disabled={busy || index === 0} onClick={() => { move(index, index - 1); setDragIndex(undefined) }}><IconChevronUpOutline14 size={14} /></button><button type="button" aria-label={`下移 ${feed.title}`} disabled={busy || index === items.length - 1} onClick={() => { move(index, index + 1); setDragIndex(undefined) }}><IconChevronDownOutline14 size={14} /></button></div></div>)}
  </div><footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="dsh-rss-primary" disabled={busy} onClick={() => { onSave(items.map(feed => feed.id)) }}>{busy ? '正在保存…' : '保存排序'}</button></footer></section></div>
}

function relativeTime(value: number): string {
  const difference = Date.now() - value
  if (difference < 60_000) return '刚刚'
  if (difference < 3_600_000) return `${String(Math.floor(difference / 60_000))} 分钟前`
  if (difference < 86_400_000) return `${String(Math.floor(difference / 3_600_000))} 小时前`
  if (difference < 604_800_000) return `${String(Math.floor(difference / 86_400_000))} 天前`
  return new Date(value).toLocaleDateString('zh-CN')
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
