import { describe, expect, it } from 'vitest'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { projectRssSessionOptions } from '../src/client/index.ts'

describe('RSS Agent Session options', () => {
  it('matches the Workspace sidebar visibility rules', () => {
    const row = (id: string, displayTitle: string, overrides: Record<string, unknown> = {}) => ({
      id, displayTitle, running: false, blank: false, updatedAt: 1, ...overrides,
    })
    const list = {
      ids: ['regular', 'hidden-blank', 'current-blank', 'subagent', 'archived'],
      current: 'current-blank',
      byId: {
        regular: row('regular', 'Regular'),
        'hidden-blank': row('hidden-blank', 'Alpha', { blank: true }),
        'current-blank': row('current-blank', 'Alpha', { blank: true }),
        subagent: row('subagent', 'Child', { origin: 'subagent' }),
        archived: row('archived', 'Archived'),
      },
    } as unknown as SessionListState
    const workspaces = {
      items: [{
        workspaceId: 'workspace-1', title: 'Alpha', path: 'D:/alpha', createdAt: '2026-08-21T00:00:00.000Z',
        sessionIds: ['regular', 'hidden-blank', 'current-blank', 'subagent', 'archived'],
      }],
      archivedSessionIds: ['archived'],
    } as unknown as WorkspaceListState

    expect(projectRssSessionOptions(list, workspaces)).toEqual([
      { id: 'regular', title: 'Regular', workspaceId: 'workspace-1', workspaceTitle: 'Alpha' },
      { id: 'current-blank', title: '新会话', workspaceId: 'workspace-1', workspaceTitle: 'Alpha' },
    ])
  })
})
