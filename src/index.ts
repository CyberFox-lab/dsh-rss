/**
 * Standalone RSS bundle for DeepSeek Harness. The Host half mounts the RSS
 * service, local SQLite provider, read-only model tools, and loopback browser
 * RPC; the browser half is discovered from the package's `dsh.client` manifest.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RssRuntime } from './service.ts'
import { LocalRssProvider, type LocalRssConfig } from './local-provider.ts'
import { registerRssRpc } from './rpc.ts'
import { registerRssTools } from './tools.ts'

export { RssRuntime, RssError } from './service.ts'
export type { RssProvider, RssFeed, RssArticle, RssArticlePage, RssArticleQuery, RssRefreshResult } from './service.ts'

/** Stable Cordis plugin name. */
export const name = 'rss'

/** Harness services required by the provider, tools, and browser RPC. */
export const inject = ['tools', 'systemPrompt', 'connection']

/** Plugin configuration for storage, network bounds, retention, and model calls. */
export interface Config {
  /** SQLite file. Defaults to `$DSH_HOME/rss/rss.sqlite`. */
  databasePath?: string
  /** Timeout for one feed HTTP request. */
  requestTimeoutMs?: number
  /** Maximum downloaded bytes for one feed document. */
  maxFeedBytes?: number
  /** Maximum followed HTTP redirects. */
  maxRedirects?: number
  /** Maximum non-favorite articles retained per feed. */
  articleLimit?: number
  /** Cooperative timeout advertised by each read-only RSS model tool. */
  toolTimeoutMs?: number
  /** Delay between completed automatic refreshes of all subscriptions. */
  autoRefreshIntervalMs?: number
}

export const Config: z<Config> = z.object({
  databasePath: z.string(),
  requestTimeoutMs: z.number().step(1).min(1_000).default(20_000),
  maxFeedBytes: z.number().step(1).min(1_024).default(5 * 1024 * 1024),
  maxRedirects: z.number().step(1).min(0).max(10).default(5),
  articleLimit: z.number().step(1).min(10).default(2_000),
  toolTimeoutMs: z.number().step(1).min(1_000).default(15_000),
  autoRefreshIntervalMs: z.number().step(1).min(60_000).default(60 * 60 * 1_000),
})

type ResolvedConfig = Required<Omit<Config, 'databasePath'>> & Pick<Config, 'databasePath'>

function startAutoRefresh(
  ctx: Context,
  runtime: RssRuntime,
  intervalMs: number,
): () => Promise<void> {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let running: Promise<void> | undefined

  const schedule = (): void => {
    timer = setTimeout(run, intervalMs)
    if (typeof timer !== 'number') timer.unref()
  }
  const run = (): void => {
    timer = undefined
    controller = new AbortController()
    const signal = controller.signal
    running = runtime.refreshAll(signal).then(
      () => undefined,
      (error: unknown) => {
        if (!signal.aborted) {
          ctx.logger.warn('rss: automatic subscription refresh failed')
          ctx.logger.warn(error)
        }
      },
    ).then(() => {
      running = undefined
      controller = undefined
      if (!disposed) schedule()
    })
  }

  schedule()
  return async () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    controller?.abort()
    await running
  }
}

/** Mount the complete RSS capability and return its deterministic teardown. */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const resolved = config as ResolvedConfig
  const runtime = new RssRuntime(ctx)
  const providerConfig: LocalRssConfig = {
    databasePath: resolved.databasePath ?? join(resolveDshHome(), 'rss', 'rss.sqlite'),
    requestTimeoutMs: resolved.requestTimeoutMs,
    maxFeedBytes: resolved.maxFeedBytes,
    maxRedirects: resolved.maxRedirects,
    articleLimit: resolved.articleLimit,
  }
  const provider = await LocalRssProvider.open(providerConfig)
  let unregister: (() => void) | undefined
  let stopAutoRefresh: (() => Promise<void>) | undefined
  try {
    unregister = runtime.registerProvider(provider)
    registerRssTools(ctx, runtime, resolved.toolTimeoutMs)
    registerRssRpc(ctx, runtime)
    stopAutoRefresh = startAutoRefresh(ctx, runtime, resolved.autoRefreshIntervalMs)
  } catch (error) {
    unregister?.()
    provider.close()
    throw error
  }
  return async () => {
    await stopAutoRefresh?.()
    unregister?.()
    provider.close()
  }
}
