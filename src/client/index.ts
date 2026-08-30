/** Browser half: Reader-derived RSS workspace, RPC client, and article-to-Agent handoff. */

import type {
  ClientContext, ConversationNode, ConversationSnapshot, SessionFace, SessionListState,
  SessionId, WorkspaceId, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ModelProviderGroup, ModelReasoningEffort } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelDirectory, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { RssArticle, RssArticlePage, RssFeed, RssRefreshResult } from '../types.ts'
import type { RssRpcEndpoint, RssRpcResultMap } from '../rpc-contract.ts'
import {
  RssPanel, RssTrigger, type RssAgentMessage, type RssAgentSnapshot, type RssAgentSource, type RssUiFace,
} from './RssUi.tsx'
import { createRssUiStore } from './store.ts'
import { RSS_STYLE } from './styles.ts'

type ModelCatalogItem = ModelProviderGroup['models'][number]

/** Required browser services for slots, transport, and the current Harness session. */
export const inject = ['slots', 'connection', 'sessions', 'workspaces', 'modelDirectories']

/** Register the RSS UI and bind it to Host RSS RPC plus the current Harness session. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const ui = createRssUiStore()
  const agent = createAgentSource(ctx)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@deepseek-ai/dsh-rss'
    style.textContent = RSS_STYLE
    document.head.append(style)
    return () => { style.remove() }
  }, 'rss-ui: styles')

  const call = async <K extends RssRpcEndpoint>(endpoint: K, payload: unknown, signal?: AbortSignal): Promise<RssRpcResultMap[K]> => {
    const result = await connection.rpc.call('/rss', endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as RssRpcResultMap[K]
  }
  const face = (): RssUiFace => ({
    hooks: { rssUi: ui.source },
    agent,
    toggle: ui.toggle, close: ui.close,
    listFeeds: signal => call('feeds/list', {}, signal),
    reorderFeeds: (ids, signal) => call('feeds/reorder', { ids }, signal),
    addFeed: (url, signal) => call('feeds/add', { url }, signal),
    removeFeed: (id, signal) => call('feeds/remove', { id }, signal),
    refreshFeed: (id, signal) => call('feeds/refresh', { id }, signal),
    refreshAll: signal => call('feeds/refresh-all', {}, signal),
    listArticles: (filters, signal) => call('articles/list', { ...filters, limit: filters.limit ?? 100, offset: filters.offset ?? 0 }, signal),
    getArticle: (id, signal) => call('articles/get', { id }, signal),
    setRead: (id, read, signal) => call('articles/read', { id, read }, signal),
    setFavorite: (id, favorite, signal) => call('articles/favorite', { id, favorite }, signal),
    promptCurrent: async (text) => {
      const current = ctx.sessions.list.getSnapshot().current
      const session = current === undefined ? undefined : ctx.sessions.binding(current)?.session
      if (session === undefined) return { ok: false, message: '当前没有 Harness 会话' }
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      return result.ok ? { ok: true } : { ok: false, message: result.error.message }
    },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'rss', order: 10, inject: face,
  }, RssTrigger))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'rss-panel', order: 60, inject: face,
  }, RssPanel))
}

function createAgentSource(ctx: ClientContext): RssAgentSource {
  const listeners = new Set<() => void>()
  let current: SessionFace | undefined
  let unsubscribeSession: (() => void) | undefined
  let modelDirectory: ModelDirectory | undefined
  let unsubscribeModel: (() => void) | undefined
  let snapshot = toAgentSnapshot(
    ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot(), undefined, undefined,
  )

  const publish = (): void => {
    snapshot = toAgentSnapshot(
      ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot(), current?.getSnapshot(),
      modelDirectory?.store.getSnapshot(),
    )
    for (const listener of listeners) listener()
  }
  const bindCurrent = (): void => {
    const currentId = ctx.sessions.list.getSnapshot().current
    const next = currentId === undefined ? undefined : ctx.sessions.binding(currentId)?.session
    if (next !== current) {
      unsubscribeSession?.()
      current = next
      unsubscribeSession = current?.subscribe(publish)
    }
    const nextDirectory = currentId === undefined || ctx.sessions.subagentAddress(currentId) !== undefined
      ? undefined
      : ctx.modelDirectories.directoryFor(currentId)
    if (nextDirectory !== modelDirectory) {
      unsubscribeModel?.()
      modelDirectory = nextDirectory
      unsubscribeModel = modelDirectory?.store.subscribe(publish)
      void modelDirectory?.load().catch(() => { publish() })
    }
    publish()
  }

  ctx.effect(() => {
    bindCurrent()
    const unsubscribeList = ctx.sessions.list.subscribe(bindCurrent)
    const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(publish)
    return () => {
      unsubscribeList()
      unsubscribeWorkspaces()
      unsubscribeSession?.()
      unsubscribeModel?.()
      unsubscribeSession = undefined
      unsubscribeModel = undefined
      current = undefined
      modelDirectory = undefined
    }
  }, 'rss-ui: current Agent conversation')

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    createWorkspace: async () => {
      try {
        const path = await ctx.workspaces.pickDirectory()
        if (path === null) return { ok: true }
        const workspace = await ctx.workspaces.create({ path })
        return { ok: true, workspaceId: String(workspace.workspaceId) }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    startSession: (workspaceId) => {
      ctx.workspaces.startSession(workspaceId === undefined ? undefined : workspaceId as WorkspaceId)
    },
    openSession: (sessionId) => { ctx.sessions.open(sessionId as SessionId) },
    selectModel: async (provider, model) => {
      const directory = modelDirectory
      if (directory === undefined) return { ok: false, message: '当前会话无法选择模型' }
      const choice = directory.store.getSnapshot().groups
        .find(group => group.id === provider)?.models.find((item: ModelCatalogItem) => item.id === model)
      if (choice === undefined) return { ok: false, message: '模型已经不在可用列表中' }
      try {
        await directory.select({
          provider, model,
          ...(choice.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: choice.reasoning.defaultEffort }),
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    selectReasoningEffort: async (effort) => {
      const directory = modelDirectory
      const currentSelection = directory?.store.getSnapshot().current
      if (directory === undefined || currentSelection === null || currentSelection === undefined) {
        return { ok: false, message: '当前会话无法选择思考等级' }
      }
      try {
        await directory.select({
          provider: currentSelection.provider, model: currentSelection.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function toAgentSnapshot(
  list: SessionListState,
  workspaces: WorkspaceListState,
  conversation: ConversationSnapshot | undefined,
  models: ModelDirectoryState | undefined,
): RssAgentSnapshot {
  const currentId = list.current
  const workspace = currentId === undefined
    ? undefined
    : workspaces.items.find(item => item.sessionIds.includes(currentId))
  const workspaceOptions = workspaces.items.map(item => ({
    id: String(item.workspaceId), title: item.title, path: item.path,
  }))
  const sessionOptions = projectRssSessionOptions(list, workspaces)
  const modelOptions = models?.groups.flatMap(group => group.models.map((model: ModelCatalogItem) => ({
    provider: group.id, providerName: group.name, id: model.id, name: model.name,
    reasoningEfforts: model.reasoning?.efforts.map((effort: ModelReasoningEffort) => ({ id: effort.id, name: effort.name })) ?? [],
    ...(model.reasoning?.defaultEffort === undefined ? {} : {
      defaultReasoningEffort: model.reasoning.defaultEffort,
    }),
  }))) ?? []
  const base = {
    workspaces: workspaceOptions,
    sessions: sessionOptions,
    ...(workspace === undefined ? {} : { workspaceId: String(workspace.workspaceId) }),
    ...(workspaces.recentWorkspaceId === undefined ? {} : { recentWorkspaceId: String(workspaces.recentWorkspaceId) }),
    models: modelOptions,
    ...(models?.current === null || models?.current === undefined ? {} : {
      modelProvider: models.current.provider,
      modelId: models.current.model,
      ...(models.current.reasoningEffort === undefined ? {} : { reasoningEffort: models.current.reasoningEffort }),
    }),
    modelBusy: models?.status === 'loading' || models?.status === 'selecting',
  }
  if (currentId === undefined || conversation === undefined) return { ...base, running: false, messages: [] }
  const messages = conversation.nodes.flatMap(toAgentMessage)
  if (conversation.partial !== null) {
    const text = conversation.partial.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n').trim()
    if (text !== '') messages.push({ id: `partial-${String(conversation.partial.turn)}-${String(conversation.partial.step)}`, role: 'assistant', text, pending: true })
  }
  for (const item of conversation.queue) {
    if (item.preview.trim() !== '') messages.push({ id: `queue-${String(item.id)}`, role: 'user', text: item.preview, pending: true })
  }
  return {
    sessionId: String(currentId),
    ...(list.byId[currentId]?.displayTitle === undefined ? {} : { sessionTitle: list.byId[currentId].displayTitle }),
    running: conversation.running,
    messages: messages.slice(-12),
    ...base,
  }
}

/**
 * Project the same visible root Session set used by the Workspace sidebar.
 * @param list - current Session summaries and selection.
 * @param workspaces - Workspace membership and global archive set.
 * @returns visible non-subagent Sessions annotated with Workspace ownership.
 */
export function projectRssSessionOptions(
  list: SessionListState,
  workspaces: WorkspaceListState,
): RssAgentSnapshot['sessions'] {
  const archived = new Set(workspaces.archivedSessionIds)
  return list.ids.flatMap((id) => {
    const summary = list.byId[id]
    if (summary === undefined || summary.origin === 'subagent' || archived.has(id)) return []
    if (summary.blank && id !== list.current) return []
    const owner = workspaces.items.find(item => item.sessionIds.includes(id))
    return [{
      id: String(id), title: summary.blank ? '新会话' : summary.displayTitle,
      ...(owner === undefined ? {} : {
        workspaceId: String(owner.workspaceId), workspaceTitle: owner.title,
      }),
    }]
  })
}

function toAgentMessage(node: ConversationNode): RssAgentMessage[] {
  if (node.kind === 'user' || node.kind === 'steering') {
    const text = node.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    return text === '' ? [] : [{ id: `${node.kind}-${String(node.seq)}`, role: 'user', text }]
  }
  if (node.kind === 'assistant') {
    const text = node.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n').trim()
    return text === '' ? [] : [{ id: `assistant-${String(node.seq)}`, role: 'assistant', text }]
  }
  return []
}

export type { RssArticle, RssArticlePage, RssFeed, RssRefreshResult }
