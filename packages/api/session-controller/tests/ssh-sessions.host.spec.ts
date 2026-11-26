/** Tests for SSH routing (`commands/list`, `fileReferences/list`), local offline caching, and pause-respecting disconnect/reconnect. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { LoopbackRemote } from '@deepseek-ai/dsh-api-gateway'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SshPasswordRequiredError, type SshWorkspaceConnectionState, type Workspace, type WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SshSessions } from '../src/ssh-sessions.ts'

const wid = (value: string) => brandString<WorkspaceId>(value)
const sid = (value: string) => brandString<SessionId>(value)

function createHarness(options: { readonly requirePassword?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-cache-spec-'))
  onTestFinished(() => { rmSync(cacheDir, { recursive: true, force: true }) })

  const ctx = new Context()
  const sshPath = 'ssh://root@192.0.2.10:22/srv/app'
  const workspaceId = wid('ws-ssh-1')
  const sessionId = sid('ssh-session-1')
  let sessionIds: SessionId[] = [sessionId]
  let inMemoryPassword: string | undefined
  const workspace: Workspace = {
    id: workspaceId,
    path: sshPath,
    title: 'Remote App',
    get sessionIds() { return sessionIds },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Workspace

  const states = new Map<WorkspaceId, SshWorkspaceConnectionState>()
  let tunnelUrl: string | undefined
  let openCount = 0
  let closeCount = 0
  const remoteCalls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  let activeStreamAbort: AbortController | undefined

  const makeRemote = (): LoopbackRemote => ({
    call: vi.fn(async (endpoint: string, args: Record<string, unknown>) => {
      remoteCalls.push({ endpoint, args })
      if (endpoint === 'workspace/create') {
        return { ok: true as const, value: { workspace: { workspaceId: 'remote-ws-1', path: '/srv/app' } } }
      }
      if (endpoint === 'session/list') {
        return {
          ok: true as const,
          value: {
            items: [{
              sessionId,
              updatedAt: 1_700_000_000_000,
              cwd: '/srv/app',
              running: false,
              agentAvailable: true,
              blank: false,
              projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'Remote Chat' } },
            }],
          },
        }
      }
      if (endpoint === 'commands/list') {
        return { ok: true as const, value: [{ name: 'plan', description: 'Plan mode' }] }
      }
      if (endpoint === 'fileReferences/list') {
        return { ok: true as const, value: [{ path: 'README.md', kind: 'file' }] }
      }
      if (endpoint === 'session/prompt') {
        return { ok: true as const, value: { accepted: true as const } }
      }
      if (endpoint === 'session/cancel') {
        return { ok: true as const, value: { accepted: true as const } }
      }
      return { ok: true as const, value: {} }
    }),
    stream: vi.fn((endpoint: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      if (endpoint === '$events') {
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (signal.aborted) { resolve(); return }
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        })()
      }
      const ctrl = new AbortController()
      activeStreamAbort = ctrl
      return (async function* () {
        yield {
          type: 'snapshot',
          header: { version: 1, id: sessionId, createdAt: 1_700_000_000_000, cwd: '/srv/app', isSeeded: false },
          cursor: 1,
          records: [
            { type: 'event', event: { type: 'user/message', seq: 0, time: 100, data: { text: 'hello' } } },
            { type: 'event', event: { type: 'assistant/message', seq: 1, time: 101, data: { text: 'hi from ssh' } } },
          ],
          hasMore: false,
          projections: { asOfSeq: 1, values: { title: 'Remote Chat' } },
          assistantStream: { revision: 0 },
        }
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { resolve(); return }
          if (ctrl.signal.aborted) { reject(new Error('ssh relay closed')); return }
          const onAbort = () => { resolve() }
          const onDrop = () => { reject(new Error('ssh relay closed')) }
          signal.addEventListener('abort', onAbort, { once: true })
          ctrl.signal.addEventListener('abort', onDrop, { once: true })
        })
      })()
    }),
    close: vi.fn(async () => { activeStreamAbort?.abort() }),
  })

  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => (id === workspaceId ? workspace : undefined),
    list: () => [workspace],
    sshWorkspaceForSession: (id: SessionId) => (sessionIds.includes(id) ? workspace : undefined),
    syncSshSessions: async (_id: WorkspaceId, next: readonly SessionId[]) => {
      sessionIds = [...next]
      return sessionIds
    },
    openSsh: vi.fn(async (id: WorkspaceId, _models?: unknown, password?: string) => {
      if (password !== undefined && password !== '') inMemoryPassword = password
      if (options.requirePassword === true && inMemoryPassword === undefined) {
        throw new SshPasswordRequiredError(id)
      }
      if (tunnelUrl === undefined) {
        openCount++
        tunnelUrl = `http://127.0.0.1:${40000 + openCount}`
      }
      states.set(id, 'connected')
      ctx.emit('workspace/ssh-status', id, 'connected')
      return tunnelUrl
    }),
    closeSsh: vi.fn(async (id: WorkspaceId) => {
      inMemoryPassword = undefined
      tunnelUrl = undefined
      closeCount++
      states.set(id, 'paused')
      ctx.emit('workspace/ssh-status', id, 'paused')
    }),
    reportSshStatus: vi.fn((id: WorkspaceId, state: SshWorkspaceConnectionState) => {
      states.set(id, state)
      ctx.emit('workspace/ssh-status', id, state)
    }),
    sshStatus: (id: WorkspaceId) => states.get(id),
  })

  const router = new SshSessions(ctx, {
    cacheDir,
    connectRemote: async () => makeRemote(),
  })
  onTestFinished(() => router.dispose())

  return {
    ctx,
    cacheDir,
    workspaceId,
    sessionId,
    router,
    remoteCalls,
    states,
    get openCount() { return openCount },
    get closeCount() { return closeCount },
  }
}

describe('SshSessions routing, offline cache, and disconnect', () => {
  it('routes commands/list and fileReferences/list to SSH and caches commands for offline + menu', async () => {
    const h = createHarness()
    const commandsResult = await h.router.call({
      namespace: 'commands',
      method: 'list',
      args: { agentId: h.sessionId },
      signal: new AbortController().signal,
    } as never)
    expect(commandsResult).toEqual({ ok: true, value: [{ name: 'plan', description: 'Plan mode' }] })

    const filesResult = await h.router.call({
      namespace: 'fileReferences',
      method: 'list',
      args: { agentId: h.sessionId, query: 'READ' },
      signal: new AbortController().signal,
    } as never)
    expect(filesResult).toEqual({ ok: true, value: [{ path: 'README.md', kind: 'file' }] })
    expect(h.openCount).toBe(1)

    await h.router.disconnect(h.workspaceId, h.sessionId)
    expect(h.states.get(h.workspaceId)).toBe('paused')
    expect(h.closeCount).toBe(1)

    // Clicking `+` while paused serves cached commands without reconnecting SSH.
    const offlineCommands = await h.router.call({
      namespace: 'commands',
      method: 'list',
      args: { agentId: h.sessionId },
      signal: new AbortController().signal,
    } as never)
    expect(offlineCommands).toEqual({ ok: true, value: [{ name: 'plan', description: 'Plan mode' }] })
    expect(h.openCount).toBe(1)
  })

  it('persists SSH conversation history locally, stays disconnected on reads, and reconnects only on prompt', async () => {
    const h = createHarness()
    // Open live follow stream to hydrate local cache.
    const abortLive = new AbortController()
    const liveStream = h.router.stream({
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: h.sessionId }, assistantStream: true } },
      signal: abortLive.signal,
    } as never)!
    const iter = liveStream[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect((first.value as { type: string; records: unknown[] }).type).toBe('snapshot')
    expect((first.value as { records: unknown[] }).records).toHaveLength(2)
    expect(h.openCount).toBe(1)

    // Disconnect SSH: tunnel closes and active stream stays alive quietly without reconnecting.
    await h.router.disconnect(h.workspaceId, h.sessionId)
    expect(h.states.get(h.workspaceId)).toBe('paused')
    expect(h.openCount).toBe(1)
    abortLive.abort()
    await iter.next()

    // Reopening the conversation while paused reads from the local cache and NEVER opens SSH.
    const abortOffline = new AbortController()
    const offlineStream = h.router.stream({
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: h.sessionId }, assistantStream: true } },
      signal: abortOffline.signal,
    } as never)!
    const offlineIter = offlineStream[Symbol.asyncIterator]()
    const offlineSnapshot = await offlineIter.next()
    expect(offlineSnapshot.done).toBe(false)
    expect(offlineSnapshot.value).toMatchObject({
      type: 'snapshot',
      cursor: 1,
      hasMore: false,
      assistantStream: { revision: 0 },
    })
    expect((offlineSnapshot.value as { records: unknown[] }).records).toHaveLength(2)
    expect(h.openCount).toBe(1)

    // Sending a prompt reconnects SSH automatically and wakes the paused follow stream.
    const nextOffline = offlineIter.next()
    const promptResult = await h.router.call({
      namespace: 'session',
      method: 'prompt',
      args: { request: { sessionId: h.sessionId, requestId: 'req-1', mode: 'queue', content: [{ type: 'text', text: 'wake up' }] } },
      signal: new AbortController().signal,
    } as never)
    expect(promptResult).toEqual({ ok: true, value: { accepted: true } })
    expect(h.openCount).toBe(2)
    expect(h.states.get(h.workspaceId)).toBe('connected')

    // The paused offline stream terminates cleanly on resume so RemoteJournalStream opens a live generation.
    const resumedEnd = await nextOffline
    expect(resumedEnd.done).toBe(true)
    abortOffline.abort()
  })

  it('keeps SSH disconnected even when workspaceFiles calls/streams run or disconnect receives an unknown sessionId', async () => {
    const h = createHarness()
    // Establish initial SSH connection.
    await h.router.call({
      namespace: 'commands',
      method: 'list',
      args: { agentId: h.sessionId },
      signal: new AbortController().signal,
    } as never)
    expect(h.openCount).toBe(1)

    // Disconnecting with a non-synced/blank sessionId still succeeds and pauses SSH.
    await h.router.disconnect(h.workspaceId, sid('blank-local-session'))
    expect(h.states.get(h.workspaceId)).toBe('paused')
    expect(h.closeCount).toBe(1)

    // Background workspaceFiles RPCs and streams must NOT reconnect SSH.
    const listResult = await h.router.call({
      namespace: 'workspaceFiles',
      method: 'list',
      args: { workspaceFileScopeId: h.sessionId, path: '.' },
      signal: new AbortController().signal,
    } as never)
    expect(listResult?.ok).toBe(false)
    expect(h.openCount).toBe(1)
    expect(h.states.get(h.workspaceId)).toBe('paused')

    const filesAbort = new AbortController()
    const filesStream = h.router.stream({
      namespace: 'workspaceFiles',
      method: 'follow',
      args: { workspaceFileScopeId: h.sessionId },
      signal: filesAbort.signal,
    } as never)!
    const filesIter = filesStream[Symbol.asyncIterator]()
    const pendingFiles = filesIter.next()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(h.openCount).toBe(1)
    expect(h.states.get(h.workspaceId)).toBe('paused')
    filesAbort.abort()
    await pendingFiles
  })

  it('requires interactive password on reconnect after disconnect and never auto-connects on list', async () => {
    const h = createHarness({ requirePassword: true })

    // Initial list() must NOT auto-connect SSH; it leaves the saved workspace paused.
    h.router.list([])
    expect(h.openCount).toBe(0)
    expect(h.states.get(h.workspaceId)).toBe('paused')

    // Reconnecting without a password reports workspace/ssh-password-required.
    await expect(h.router.reconnect(h.workspaceId, h.sessionId)).rejects.toMatchObject({
      code: 'workspace/ssh-password-required',
    })
    expect(h.states.get(h.workspaceId)).toBe('paused')

    // Supplying the interactive password connects SSH.
    await h.router.reconnect(h.workspaceId, h.sessionId, 'ephemeral-pass')
    expect(h.openCount).toBe(1)
    expect(h.states.get(h.workspaceId)).toBe('connected')

    // Disconnecting clears the in-memory password so the next prompt asks for it again.
    await h.router.disconnect(h.workspaceId, h.sessionId)
    expect(h.states.get(h.workspaceId)).toBe('paused')
    await expect(h.router.call({
      namespace: 'session',
      method: 'prompt',
      args: { request: { sessionId: h.sessionId, requestId: 'req-pw', mode: 'queue', content: [{ type: 'text', text: 'hi' }] } },
      signal: new AbortController().signal,
    } as never)).rejects.toMatchObject({
      code: 'workspace/ssh-password-required',
    })
    expect(h.states.get(h.workspaceId)).toBe('paused')
  })
})
