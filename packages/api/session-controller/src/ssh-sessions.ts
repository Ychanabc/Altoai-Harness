/** Keeps the desktop UI and registry local while addressing Sessions on their SSH Host. */
import type { Context } from '@deepseek-ai/cordis'
import { connectLoopbackRemote, type LoopbackRemote } from '@deepseek-ai/dsh-api-gateway'
import type { InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { parseSshWorkspacePath, SshPasswordRequiredError, type Workspace, type WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import { SshLocalCache } from './ssh-local-cache.ts'
import { desktopModels } from './ssh-models.ts'
import type { SessionFollowRequest, SessionPageRequest, SessionSummary } from './types.ts'

const unarySessionMethods = new Set([
  'attachment', 'cancel', 'events', 'fork', 'page', 'projections', 'prompt',
  'rename', 'rewind', 'selectModel', 'state', 'updateQueue', 'wait',
])
const streamSessionMethods = new Set(['follow', 'observeEvent', 'observeProjections', 'observeState'])
const workspaceFileCalls = new Set(['read', 'readBytes', 'stat', 'list', 'search', 'follow'])
const passiveSessionCalls = new Set(['events', 'page', 'projections', 'state'])
const summarySchema = z.object({
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  updatedAt: z.number().finite(),
  cwd: z.string().optional(),
  running: z.boolean(),
  agentAvailable: z.boolean(),
  blank: z.boolean(),
}).passthrough()
const listSchema = z.object({ items: z.array(summarySchema) })
const workspaceSchema = z.object({ workspace: z.object({ workspaceId: z.string(), path: z.string() }) })
const createdSchema = z.object({ sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)) })

interface Connection {
  readonly url: string
  readonly remote: LoopbackRemote
  readonly project: { readonly workspaceId: string; readonly path: string }
  readonly abort: AbortController
  retired: boolean
}

const interruptedMessage = 'SSH connection interrupted. The remote task may still be running. Reconnect to check its status or stop it.'

/** Options for {@link SshSessions} construction (primarily for test isolation). */
export interface SshSessionsOptions {
  /** Override the local SSH cache directory. */
  readonly cacheDir?: string
  /** Override the loopback Remote factory used to connect to an SSH tunnel URL. */
  readonly connectRemote?: (url: string, signal: AbortSignal) => Promise<LoopbackRemote>
}

/** One registry-backed router. Account, settings, and plugin operations are never selected here. */
export class SshSessions {
  private readonly lifetime = new AbortController()
  private readonly connections = new Map<WorkspaceId, Promise<Connection>>()
  private readonly syncing = new Map<WorkspaceId, Promise<readonly SessionSummary[]>>()
  private readonly summaries = new Map<WorkspaceId, readonly SessionSummary[]>()
  private readonly cache: SshLocalCache
  private readonly paused: Set<WorkspaceId>
  private readonly resumeWaiters = new Map<WorkspaceId, Set<() => void>>()
  private readonly connectRemote: (url: string, signal: AbortSignal) => Promise<LoopbackRemote>

  constructor(private readonly ctx: Context, options: SshSessionsOptions = {}) {
    this.cache = new SshLocalCache(options.cacheDir)
    this.paused = this.cache.loadPausedWorkspaces()
    this.connectRemote = options.connectRemote ?? connectLoopbackRemote
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const waiters of this.resumeWaiters.values()) {
      for (const wake of waiters) wake()
    }
    this.resumeWaiters.clear()
    await Promise.allSettled([
      this.cache.flush(),
      ...[...this.connections.values()].map(async (pending) => {
        const connection = await pending
        connection.abort.abort()
        await connection.remote.close()
      }),
    ])
  }

  /**
   * End a user-requested local SSH relay after attempting to stop the selected
   * remote turn. Marks the Workspace paused before closing sockets so open
   * conversation streams stay readable from the local cache and never trigger
   * an automatic reconnect until the user sends a prompt or clicks Reconnect.
   * @param workspaceId - Saved SSH Workspace that owns the carrier.
   * @param sessionId - Current remote Session to cancel before closing, when supplied.
   * @returns resolution after the local SSH relay is closed.
   */
  async disconnect(workspaceId: WorkspaceId, sessionId?: SessionId): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || parseSshWorkspacePath(workspace.path) === undefined) {
      throw new Error('Select a saved SSH workspace on the desktop')
    }
    // Pause BEFORE closing the tunnel so active follow/file streams hold quietly
    // in offline mode instead of failing into a reconnect retry loop.
    this.markPaused(workspace.id)
    const pending = this.connections.get(workspace.id)
    this.connections.delete(workspace.id)
    // Never block disconnect on a slow or hanging SSH startup attempt: only send
    // best-effort session/cancel if a connection is already established.
    const settled = pending === undefined
      ? undefined
      : await Promise.race([
        pending.then(value => value, () => undefined),
        Promise.resolve(undefined),
      ])
    if (settled !== undefined && !settled.abort.signal.aborted) {
      if (sessionId !== undefined && workspace.sessionIds.includes(sessionId)) {
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(1_500)])
        try {
          await settled.remote.call('session/cancel', { request: { sessionId } }, signal)
        } catch (_cancelFailed) {
          // Closing the local relay still leaves the remote outcome visibly unknown until reconnection.
        }
      }
      this.retire(workspace, settled)
    } else if (pending !== undefined) {
      void pending.then((late) => { this.retire(workspace, late) }, () => undefined)
    }
    await this.ctx.workspaceRegistry.closeSsh(workspace.id)
    this.ctx.workspaceRegistry.reportSshStatus(workspace.id, 'paused')
    this.ctx.emit('workspace/ssh-status', workspace.id, 'paused')
    this.clearRunning(workspace)
  }

  /**
   * Reopen a user-paused or interrupted SSH relay without allocating another
   * Session. The refreshed summary list restores the existing remote history
   * into the desktop's normal main-window Session path.
   * @param workspaceId - Saved SSH Workspace whose relay should reopen.
   * @param _sessionId - Existing Session expected to belong to the Workspace, when the caller is resuming one.
   * @param password - Interactive SSH password for this connection; never persisted on disk.
   */
  async reconnect(workspaceId: WorkspaceId, _sessionId?: SessionId, password?: string): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || parseSshWorkspacePath(workspace.path) === undefined) {
      throw new Error('Select a saved SSH workspace on the desktop')
    }
    this.clearPaused(workspace.id)
    try {
      if (password !== undefined && password !== '') {
        await this.connect(workspace, password)
      }
      await this.sync(workspace)
      this.notifyResumed(workspace.id)
    } catch (cause) {
      if (isPasswordRequired(cause)) {
        this.markPaused(workspace.id)
        this.ctx.workspaceRegistry.reportSshStatus(workspace.id, 'paused')
        this.ctx.emit('workspace/ssh-status', workspace.id, 'paused')
        throw new RemoteError('workspace/ssh-password-required', 'Enter the SSH password to connect.', { workspaceId: workspace.id }, { cause })
      }
      throw cause
    }
  }

  /**
   * Return locally cached summaries immediately without auto-connecting SSH.
   * Because SSH passwords are never persisted on disk, saved SSH workspaces
   * stay paused until the user explicitly connects or sends a message.
   */
  list(local: readonly SessionSummary[]): readonly SessionSummary[] {
    const workspaces = this.ctx.workspaceRegistry.list().filter(workspace => parseSshWorkspacePath(workspace.path) !== undefined)
    for (const workspace of workspaces) {
      if (!this.summaries.has(workspace.id)) {
        const cached = this.cache.getSummaries(workspace.id)
        if (cached.length > 0) this.summaries.set(workspace.id, cached)
      }
      const status = this.ctx.workspaceRegistry.sshStatus(workspace.id)
      // Start saved SSH workspaces paused on boot (never auto-connect in background).
      if (status === undefined && !this.connections.has(workspace.id)) {
        this.paused.add(workspace.id)
        this.ctx.workspaceRegistry.reportSshStatus(workspace.id, 'paused')
      } else if (this.paused.has(workspace.id)) {
        this.ctx.workspaceRegistry.reportSshStatus(workspace.id, 'paused')
      }
      const resolved = this.ctx.workspaceRegistry.sshStatus(workspace.id)
      if (resolved !== undefined) this.ctx.emit('workspace/ssh-status', workspace.id, resolved)
    }
    const ids = new Set(local.map(item => item.sessionId))
    const remote: SessionSummary[] = []
    for (const workspace of workspaces) {
      const visible = new Set(workspace.sessionIds)
      for (const item of this.summaries.get(workspace.id) ?? []) {
        if (!visible.has(item.sessionId) || ids.has(item.sessionId)) continue
        ids.add(item.sessionId)
        remote.push(item)
      }
    }
    return remote.length === 0 ? local : [...local, ...remote].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async call(request: InvokeRemoteRequest) {
    const { namespace, method, args } = request
    const input = record(args.request)
    if (namespace === 'session' && method === 'create') {
      const workspaceId = string(input?.workspaceId)
      const workspace = workspaceId === undefined ? undefined : this.ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
      if (workspace === undefined || parseSshWorkspacePath(workspace.path) === undefined) return undefined
      const wasPaused = this.paused.has(workspace.id)
      this.clearPaused(workspace.id)
      return this.onWorkspace(workspace, async (connection) => {
        await this.sync(workspace)
        const requested = string(input?.sessionId)
        const reuse = requested !== undefined && workspace.sessionIds.some(id => id === requested)
        const result = await connection.remote.call('session/create', {
          request: {
            workspaceId: connection.project.workspaceId,
            ...(reuse ? { sessionId: requested } : {}),
            ...(typeof input?.agentPreset === 'string' ? { agentPreset: input.agentPreset } : {}),
          },
        }, request.signal)
        if (result.ok) await this.admitCreated(workspace, result.value)
        if (wasPaused) this.notifyResumed(workspace.id)
        return result
      })
    }
    if (!routable(namespace, method, false)) return undefined
    const sessionId = target(args)
    const workspace = this.find(sessionId)
    if (workspace === undefined) return undefined
    if ((namespace === 'session' && method === 'cancel') || (namespace === 'subagents' && method === 'interruptByUser')) {
      return this.cancelOnWorkspace(workspace, namespace + '/' + method, args, sessionId, request.signal)
    }

    const brandedSessionId = sessionId === undefined ? undefined : brandString<SessionId>(sessionId)
    // Passive reads must never force a paused SSH Workspace to reconnect, and
    // gracefully serve locally cached history/commands when offline.
    if (isPassiveUnary(namespace, method)) {
      if (this.paused.has(workspace.id)) {
        return this.passiveOfflineResult(workspace, namespace, method, brandedSessionId, input)
      }
      try {
        const result = await this.onWorkspace(workspace, async (connection) => {
          return await connection.remote.call(namespace + '/' + method, args, request.signal)
        })
        if (result.ok) {
          this.recordPassiveSuccess(workspace, namespace, method, brandedSessionId, result.value)
        }
        return result
      } catch (_offline) {
        return this.passiveOfflineResult(workspace, namespace, method, brandedSessionId, input)
      }
    }

    // Only explicit message-sending or command execution actions may reconnect
    // a user-disconnected SSH Workspace. Every background/file/passive RPC
    // stays offline while paused so Disconnect never snaps back to Connected.
    if (this.paused.has(workspace.id) && !canAutoReconnect(namespace, method)) {
      return {
        ok: false as const,
        error: new RemoteError('workspace/ssh-unavailable', 'SSH workspace is currently paused.', { workspaceId: workspace.id }),
      }
    }

    const wasPaused = this.paused.has(workspace.id)
    if (wasPaused) this.clearPaused(workspace.id)
    return this.onWorkspace(workspace, async (connection) => {
      if (wasPaused) {
        this.notifyResumed(workspace.id)
        void this.sync(workspace).catch(() => {})
      }
      const result = await connection.remote.call(namespace + '/' + method, args, request.signal)
      if (result.ok && namespace === 'session' && method === 'fork') await this.admitCreated(workspace, result.value)
      if (result.ok && namespace === 'session' && method === 'rewind') {
        await this.admitCreated(workspace, result.value)
        const parsed = createdSchema.safeParse(result.value)
        if (parsed.success && brandedSessionId !== undefined) {
          const nextId = parsed.data.sessionId
          const wasPinned = this.ctx.workspaceRegistry.pinnedSessionIds.includes(brandedSessionId)
          try {
            await workspace.insertSessionBefore(nextId, brandedSessionId)
          } catch {
            // Ordering preservation is best-effort for remote SSH workspaces.
          }
          if (wasPinned) {
            try {
              await this.ctx.workspaceRegistry.pinSession(nextId)
            } catch {
              // Pin preservation is best-effort for remote SSH workspaces.
            }
          }
          try {
            await this.ctx.workspaceRegistry.deleteSession(brandedSessionId)
          } catch {
            // Hiding the replaced SSH session is best-effort.
          }
        }
      }
      return result
    })
  }

  stream(request: InvokeRemoteRequest): AsyncIterable<unknown> | undefined {
    if (!routable(request.namespace, request.method, true)) return undefined
    const workspace = this.find(target(request.args))
    if (workspace === undefined || request.signal === undefined) return undefined
    return this.forward(workspace, request, request.signal)
  }

  private async *forward(workspace: Workspace, request: InvokeRemoteRequest, signal: AbortSignal): AsyncIterable<unknown> {
    const rawSessionId = target(request.args)
    const sessionId = rawSessionId === undefined ? undefined : brandString<SessionId>(rawSessionId)
    const followInput = record(request.args.request) as Partial<SessionFollowRequest> | undefined

    // While paused, NEVER open SSH for any stream (conversation follow, state
    // observers, or workspaceFiles/follow). Serve cached snapshots when available
    // and hold quietly until the user sends a prompt or clicks Reconnect.
    if (this.paused.has(workspace.id)) {
      const opening = this.offlineOpeningFrame(workspace, request.namespace, request.method, sessionId, followInput)
      if (opening !== undefined) yield opening
      await this.waitUntilResumed(workspace.id, signal)
      return
    }

    let connection: Connection
    try {
      connection = await this.onWorkspace(workspace, async connected => connected)
    } catch (cause) {
      // If the SSH server is unreachable while opening a conversation, still let
      // the user read locally cached messages offline instead of showing a blank error.
      const opening = this.offlineOpeningFrame(workspace, request.namespace, request.method, sessionId, followInput)
      if (opening !== undefined && sessionId !== undefined && request.namespace === 'session' && request.method === 'follow') {
        yield opening
        await this.waitUntilResumed(workspace.id, signal)
        return
      }
      throw cause
    }

    let yielded = false
    const streamSignal = AbortSignal.any([signal, connection.abort.signal])
    try {
      for await (const frame of connection.remote.stream(request.namespace + '/' + request.method, request.args, streamSignal, request.uplink)) {
        yielded = true
        if (request.namespace === 'session' && request.method === 'follow' && sessionId !== undefined) {
          this.cache.recordFollowFrame(workspace, sessionId, frame)
        }
        yield frame
      }
      // If the user explicitly disconnected SSH while this stream was open, keep
      // the already-rendered conversation alive in offline mode until resumed.
      if (this.paused.has(workspace.id) && !signal.aborted) {
        await this.waitUntilResumed(workspace.id, signal)
      }
    } catch (cause) {
      if (signal.aborted) throw cause
      if (this.paused.has(workspace.id)) {
        // Disconnect closed the relay intentionally: hold quietly until prompt or reconnect.
        if (!yielded) {
          const opening = this.offlineOpeningFrame(workspace, request.namespace, request.method, sessionId, followInput)
          if (opening !== undefined) yield opening
        }
        await this.waitUntilResumed(workspace.id, signal)
        return
      }
      this.interrupted(workspace, connection)
      if (yielded && request.namespace === 'session' && request.method === 'follow') {
        await this.waitUntilResumed(workspace.id, signal)
        return
      }
      throw cause
    }
  }

  private offlineOpeningFrame(
    workspace: Workspace,
    namespace: string,
    method: string,
    sessionId: SessionId | undefined,
    followInput: Partial<SessionFollowRequest> | undefined,
  ): unknown {
    if (namespace !== 'session' || sessionId === undefined) return undefined
    if (method === 'follow') {
      return this.cache.buildOfflineSnapshot(workspace, sessionId, followInput)
    }
    if (method === 'observeEvent' || method === 'observeProjections') {
      return { type: 'ready' as const }
    }
    if (method === 'observeState') {
      return this.cache.buildOfflineState(sessionId)
    }
    return undefined
  }

  private passiveOfflineResult(
    workspace: Workspace,
    namespace: string,
    method: string,
    sessionId: SessionId | undefined,
    input: Record<string, unknown> | undefined,
  ) {
    if (namespace === 'commands' && method === 'list') {
      return { ok: true as const, value: this.cache.getCommands(workspace.id) }
    }
    if (namespace === 'skills' && method === 'list') {
      return { ok: true as const, value: { skills: [] } }
    }
    if (namespace === 'fileReferences' && method === 'list') {
      return { ok: true as const, value: [] }
    }
    if (namespace === 'session' && sessionId !== undefined) {
      if (method === 'page' || method === 'events') {
        return {
          ok: true as const,
          value: this.cache.buildOfflinePage(sessionId, input as Partial<SessionPageRequest> | undefined),
        }
      }
      if (method === 'projections') {
        return { ok: true as const, value: this.cache.buildOfflineProjections(workspace, sessionId) }
      }
      if (method === 'state') {
        return { ok: true as const, value: this.cache.buildOfflineState(sessionId) }
      }
    }
    return {
      ok: false as const,
      error: new RemoteError('workspace/ssh-unavailable', 'SSH workspace is currently paused.', { workspaceId: workspace.id }),
    }
  }

  private recordPassiveSuccess(
    workspace: Workspace,
    namespace: string,
    method: string,
    sessionId: SessionId | undefined,
    value: unknown,
  ): void {
    if (namespace === 'commands' && method === 'list' && Array.isArray(value)) {
      this.cache.setCommands(workspace.id, value)
      return
    }
    if (namespace === 'session' && sessionId !== undefined) {
      if (method === 'page' || method === 'events') {
        this.cache.recordPage(workspace, sessionId, value)
      } else if (method === 'projections') {
        this.cache.recordProjections(workspace, sessionId, value)
      }
    }
  }

  private markPaused(workspaceId: WorkspaceId): void {
    if (this.paused.has(workspaceId)) return
    this.paused.add(workspaceId)
    this.cache.savePausedWorkspaces(this.paused)
  }

  private clearPaused(workspaceId: WorkspaceId): void {
    if (!this.paused.delete(workspaceId)) return
    this.cache.savePausedWorkspaces(this.paused)
  }

  private notifyResumed(workspaceId: WorkspaceId): void {
    const waiters = this.resumeWaiters.get(workspaceId)
    if (waiters === undefined) return
    this.resumeWaiters.delete(workspaceId)
    for (const wake of waiters) wake()
  }

  private waitUntilResumed(workspaceId: WorkspaceId, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.lifetime.signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', done)
        this.lifetime.signal.removeEventListener('abort', done)
        const set = this.resumeWaiters.get(workspaceId)
        set?.delete(done)
        if (set !== undefined && set.size === 0) this.resumeWaiters.delete(workspaceId)
        resolve()
      }
      let set = this.resumeWaiters.get(workspaceId)
      if (set === undefined) {
        set = new Set()
        this.resumeWaiters.set(workspaceId, set)
      }
      set.add(done)
      signal.addEventListener('abort', done, { once: true })
      this.lifetime.signal.addEventListener('abort', done, { once: true })
    })
  }

  private find(id: string | undefined): Workspace | undefined {
    if (id === undefined) return undefined
    return this.ctx.workspaceRegistry.sshWorkspaceForSession(brandString<SessionId>(id))
  }

  private async admitCreated(workspace: Workspace, value: unknown): Promise<void> {
    const { sessionId } = createdSchema.parse(value)
    // A refresh already in flight may have read its list before the write.
    await this.sync(workspace)
    if (!workspace.sessionIds.includes(sessionId)) await this.sync(workspace)
    if (!workspace.sessionIds.includes(sessionId)) throw new Error('The SSH runtime did not publish the created Session')
  }

  private async onWorkspace<T>(workspace: Workspace, use: (connection: Connection) => Promise<T>): Promise<T> {
    try {
      return await use(await this.connect(workspace))
    } catch (cause) {
      if (isPasswordRequired(cause)) {
        this.markPaused(workspace.id)
        this.ctx.workspaceRegistry.reportSshStatus(workspace.id, 'paused')
        this.ctx.emit('workspace/ssh-status', workspace.id, 'paused')
        throw new RemoteError('workspace/ssh-password-required', 'Enter the SSH password to connect.', { workspaceId: workspace.id }, { cause })
      }
      throw new RemoteError('workspace/ssh-unavailable', 'SSH workspace connection failed. ' +
        (cause instanceof Error ? cause.message : 'Check the saved connection.'), { workspaceId: workspace.id }, { cause })
    }
  }

  private async connect(workspace: Workspace, password?: string): Promise<Connection> {
    if (this.paused.has(workspace.id)) {
      throw new Error('SSH workspace is currently paused')
    }
    const url = await this.ctx.workspaceRegistry.openSsh(workspace.id, desktopModels(this.ctx), password)
    this.lifetime.signal.throwIfAborted()
    if (this.paused.has(workspace.id)) {
      throw new Error('SSH workspace is currently paused')
    }
    let pending = this.connections.get(workspace.id)
    const previous = pending === undefined ? undefined : await pending.then(connection => connection, () => undefined)
    if (previous?.url === url && !previous.abort.signal.aborted) return previous
    // Multiple requests can share the registry's foreground server startup.
    const current = this.connections.get(workspace.id)
    if (current !== pending && current !== undefined) return current
    previous?.abort.abort()
    if (previous !== undefined) void previous.remote.close()
    pending = this.open(workspace, url)
    this.connections.set(workspace.id, pending)
    try {
      return await pending
    } catch (error) {
      if (this.connections.get(workspace.id) === pending) this.connections.delete(workspace.id)
      throw error
    }
  }

  private async open(workspace: Workspace, url: string): Promise<Connection> {
    const location = parseSshWorkspacePath(workspace.path)
    if (location === undefined) throw new Error('The workspace is not an SSH project')
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(12_000)])
    const remote = await this.connectRemote(url, signal)
    try {
      const result = await remote.call('workspace/create', { request: { path: location.remotePath } }, signal)
      if (!result.ok) throw new Error(result.error.message)
      const abort = new AbortController()
      const connection = { url, remote, project: workspaceSchema.parse(result.value).workspace, abort, retired: false }
      void this.observe(workspace, connection).catch(() => { this.interrupted(workspace, connection) })
      return connection
    } catch (error) {
      await remote.close()
      throw error
    }
  }

  private sync(workspace: Workspace): Promise<readonly SessionSummary[]> {
    const active = this.syncing.get(workspace.id)
    if (active !== undefined) return active
    const task = this.pull(workspace).finally(() => { this.syncing.delete(workspace.id) })
    this.syncing.set(workspace.id, task)
    return task
  }

  private async pull(workspace: Workspace): Promise<readonly SessionSummary[]> {
    if (this.paused.has(workspace.id)) return this.summaries.get(workspace.id) ?? []
    const connection = await this.connect(workspace)
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(12_000)])
    const result = await connection.remote.call('session/list', { _request: {} }, signal)
    if (!result.ok) throw new Error(result.error.message)
    const candidates = listSchema.parse(result.value).items.filter(item => item.cwd === connection.project.path)
    const unique: SessionSummary[] = []
    for (const item of candidates) {
      const other = this.find(item.sessionId)
      if (other !== undefined && other.id !== workspace.id) continue
      if (this.ctx.sessions.get(item.sessionId) !== undefined
        || await this.ctx.get('sessionPersistence')?.stat(item.sessionId) !== undefined) continue
      unique.push({ ...item, cwd: workspace.path } as SessionSummary)
    }
    const previous = this.summaries.get(workspace.id) ?? []
    const visible = new Set(await this.ctx.workspaceRegistry.syncSshSessions(workspace.id, unique.map(item => item.sessionId)))
    const items = unique.filter(item => visible.has(item.sessionId))
    this.summaries.set(workspace.id, items)
    this.cache.setSummaries(workspace.id, items)
    for (const item of previous) if (!visible.has(item.sessionId)) this.ctx.emit('api-session/removed', item.sessionId)
    for (const item of items) this.ctx.emit('api-session/added', item)
    return items
  }

  private async observe(workspace: Workspace, connection: Connection): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, connection.abort.signal])
    for await (const frame of connection.remote.stream('$events', {}, signal)) {
      if (this.ctx.workspaceRegistry.get(workspace.id) !== workspace) return
      const event = record(frame)
      if (event?.type !== 'emit' || !Array.isArray(event.args)) continue
      const [id, value]: unknown[] = event.args
      if (event.event === 'api-session/added' || event.event === 'api-session/removed') {
        if (!this.paused.has(workspace.id)) await this.sync(workspace)
        continue
      }
      if (typeof id !== 'string' || !workspace.sessionIds.some(candidate => candidate === id)) continue
      const sessionId = brandString<SessionId>(id)
      if (event.event === 'api-session/status' && typeof value === 'boolean') this.ctx.emit('api-session/status', sessionId, value)
      if (event.event === 'api-session/activity' && typeof value === 'number') this.ctx.emit('api-session/activity', sessionId, value)
      if (event.event === 'api-session/error' && typeof value === 'string') this.ctx.emit('api-session/error', sessionId, value)
    }
  }

  private async currentConnection(id: WorkspaceId): Promise<Connection | undefined> {
    const pending = this.connections.get(id)
    if (pending === undefined) return undefined
    const connection = await pending.then(value => value, () => undefined)
    return connection?.abort.signal.aborted === false ? connection : undefined
  }

  private interrupted(workspace: Workspace, connection: Connection): void {
    if (this.lifetime.signal.aborted || connection.retired || this.paused.has(workspace.id)) return
    this.retire(workspace, connection)
    this.ctx.workspaceRegistry.reportSshStatus(workspace.id, 'interrupted')
    for (const sessionId of workspace.sessionIds) this.ctx.emit('api-session/error', sessionId, interruptedMessage)
  }

  private async cancelOnWorkspace(
    workspace: Workspace,
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    sessionId: string | undefined,
    callerSignal: AbortSignal | undefined,
  ) {
    const targetIds = sessionId === undefined ? undefined : [brandString<SessionId>(sessionId)]
    const connection = await this.currentConnection(workspace.id)
    if (connection === undefined) {
      this.clearRunning(workspace, targetIds)
      return { ok: true as const, value: { accepted: true as const } }
    }
    const signal = callerSignal === undefined
      ? AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)])
      : AbortSignal.any([this.lifetime.signal, callerSignal, AbortSignal.timeout(5_000)])
    try {
      const result = await connection.remote.call(endpoint, args, signal)
      if (!result.ok && (
        result.error.code === 'session/not-found'
        || result.error.code === 'gateway/internal'
        || result.error.code === 'gateway/cancelled'
      )) {
        this.clearRunning(workspace, targetIds)
        return { ok: true as const, value: { accepted: true as const } }
      }
      return result
    } catch (_cancelFailed) {
      // The SSH tunnel dropped mid-cancel: retire the dead relay and clear local running state.
      this.interrupted(workspace, connection)
      this.clearRunning(workspace, targetIds)
      return { ok: true as const, value: { accepted: true as const } }
    }
  }

  private clearRunning(workspace: Workspace, targetIds?: readonly SessionId[]): void {
    const targets = targetIds ?? workspace.sessionIds
    if (targets.length === 0) return
    const targetSet = new Set(targets)
    const cached = this.summaries.get(workspace.id)
    if (cached !== undefined) {
      let changed = false
      const updated = cached.map((item) => {
        if (!targetSet.has(item.sessionId) || !item.running) return item
        changed = true
        return { ...item, running: false }
      })
      if (changed) {
        this.summaries.set(workspace.id, updated)
        this.cache.setSummaries(workspace.id, updated)
      }
    }
    for (const id of targets) this.ctx.emit('api-session/status', id, false)
  }

  private retire(workspace: Workspace, connection: Connection): void {
    if (connection.retired) return
    connection.retired = true
    connection.abort.abort()
    const pending = this.connections.get(workspace.id)
    if (pending !== undefined) {
      void pending.then((active) => {
        if (active === connection && this.connections.get(workspace.id) === pending) this.connections.delete(workspace.id)
      }, () => undefined)
    }
    void connection.remote.close()
  }
}

function isPasswordRequired(error: unknown): boolean {
  if (error instanceof SshPasswordRequiredError) return true
  if (error instanceof RemoteError && error.code === 'workspace/ssh-password-required') return true
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'SSH_PASSWORD_REQUIRED') return true
  return false
}

function canAutoReconnect(namespace: string, method: string): boolean {
  return (namespace === 'session' && (method === 'prompt' || method === 'rewind'))
    || (namespace === 'subagents' && method === 'prompt')
    || (namespace === 'commands' && method === 'execute')
}

function isPassiveUnary(namespace: string, method: string): boolean {
  if (namespace === 'session') return passiveSessionCalls.has(method)
  return (namespace === 'commands' && method === 'list')
    || (namespace === 'skills' && method === 'list')
    || (namespace === 'fileReferences' && method === 'list')
}

function routable(namespace: string, method: string, stream: boolean): boolean {
  if (namespace === 'session') return (stream ? streamSessionMethods : unarySessionMethods).has(method)
  if (namespace === 'workspaceFiles') return workspaceFileCalls.has(method)
  return !stream && ((namespace === 'skills' && method === 'list')
    || (namespace === 'commands' && (method === 'list' || method === 'execute'))
    || (namespace === 'fileReferences' && method === 'list')
    || (namespace === 'fileUploads' && method === 'upload')
    || (namespace === 'subagents' && (method === 'prompt' || method === 'interruptByUser')))
}

function target(args: Readonly<Record<string, unknown>>): string | undefined {
  const request = record(args.request)
  const address = record(request?.address)
  return string(request?.sessionId) ?? string(address?.sessionId) ?? string(address?.parentSessionId)
    ?? string(args.workspaceFileScopeId) ?? string(args.agentId) ?? string(args.sessionId) ?? string(args.childSessionId)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
