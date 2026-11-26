/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form.
 * @module @deepseek-ai/dsh-workspace
 */

import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { parse, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
export { formatSshWorkspacePath, parseSshWorkspacePath, verifySshWorkspacePath } from './ssh-path.ts'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath, realpathNormalize } from './paths.ts'
import { SshWebHost } from './ssh-web.ts'
import { sshFiles, type SshFilesResult } from './ssh-files.ts'
import {
  formatSshWorkspacePath, parseSshWorkspacePath, probeSshDirectory, sshWorkspaceAuthority, verifySshWorkspacePath,
  type SshWorkspaceConnection,
  type SshWorkspaceUpdateConnection,
} from './ssh-path.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type {
  SessionActivity,
  SshWorkspaceConnectionState,
  Workspace,
  WorkspaceId as WorkspaceIdBrand,
} from './types.ts'

function sshCredentialKey(authority: string): CredentialKey {
  const id = createHash('sha256').update(authority).digest('hex')
  return brandString<CredentialKey>(`workspace/ssh-${id}`)
}

interface StoredSshHostRecord {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly fingerprint: string
}

function storedSshHost(record: CredentialRecord | undefined): StoredSshHostRecord | undefined {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) return undefined
  const value = record.payload as Partial<StoredSshHostRecord>
  if (typeof value.host !== 'string' || typeof value.port !== 'number' || typeof value.username !== 'string'
    || typeof value.fingerprint !== 'string') return undefined
  return { host: value.host, port: value.port, username: value.username, fingerprint: value.fingerprint }
}

/** Raised when opening an SSH Workspace requires an interactive password prompt. */
export class SshPasswordRequiredError extends Error {
  readonly code = 'SSH_PASSWORD_REQUIRED' as const
  constructor(readonly workspaceId: WorkspaceId) {
    super('Enter the SSH password to connect to this workspace.')
    this.name = 'SshPasswordRequiredError'
  }
}

export type {
  SessionActivity, SessionActivityItem, SessionActivityKind, SessionActivityKindMap, SshWorkspaceConnectionState, Workspace,
} from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * An archiveSession or pinSession request named a session neither live nor in
 * session persistence — a definite miss only; storage faults propagate as
 * themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   * @param verb - The registry operation that named the session.
   */
  constructor(readonly sessionId: SessionId, verb: 'archive' | 'pin') {
    super(`cannot ${verb} session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/**
 * An archiveSession request named a session that at least one
 * `workspace/session-activity` listener reported active. Nothing was written;
 * `activity` names what must stop before the session can be archived.
 */
export class WorkspaceActiveSessionError extends Error {
  /**
   * @param sessionId - The active session id.
   * @param activity - The reported activity, in listener order.
   */
  constructor(readonly sessionId: SessionId, readonly activity: readonly SessionActivity[]) {
    super(`cannot archive session '${sessionId}': the session is active (${activity.map(entry => entry.kind).join(', ')})`)
    this.name = 'WorkspaceActiveSessionError'
  }
}

/** A pinSession request named a session currently in the archive set; pinning and archival are mutually exclusive. */
export class WorkspaceArchivedSessionPinError extends Error {
  /**
   * @param sessionId - The archived session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot pin session '${sessionId}': the session is archived`)
    this.name = 'WorkspaceArchivedSessionPinError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}


/** The session an archive request is about to write into the archive set. */
export interface SessionActivityRequest {
  readonly sessionId: SessionId
}

/** Caller choices for {@link WorkspaceRegistry.archiveSession}. */
export interface ArchiveSessionOptions {
  /**
   * Ask the composed providers to stop the session's running work instead of
   * refusing the archive because of it. The archive is written first, then
   * the stops are requested; running work is never awaited to settlement, and
   * a provider failure is logged without undoing the archive.
   */
  readonly stopActivity?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }

  interface Events {
    /**
     * A desktop SSH Session reference was hidden durably.
     * @mode emit
     * @param sessionId - removed local reference.
     */
    'workspace/ssh-session-hidden'(sessionId: SessionId): void
    /**
     * Ask the composed providers what still runs for a session before it is
     * archived. A listener prepends its own {@link SessionActivity} entries to
     * the result of `next()`; the registry's innermost callback returns an
     * empty list, so a composition without providers archives freely. Any
     * non-empty result refuses the archive without a write.
     * @param request - the session about to be archived.
     * @param next - delegate to the remaining providers.
     * @mode waterfall
     */
    'workspace/session-activity'(
      request: SessionActivityRequest,
      next: () => Promise<readonly SessionActivity[]>,
    ): Promise<readonly SessionActivity[]>
    /**
     * Stop a session's running work because the caller archived it with
     * `stopActivity`; the archive set is durable when this dispatches. Each
     * provider stops its own families — cancelling a turn, its subagent
     * descendants, owned jobs, or active schedules — through the same cancel
     * paths the user's own stop actions use, so the session log ends every
     * open turn regularly and a later unarchive can continue the
     * conversation. Listeners issue their stop requests without waiting for
     * running work to settle; a listener may await its own durability
     * barrier. A rejection is logged by the registry and does not undo the
     * archive.
     * @param request - the session being archived.
     * @mode parallel
     */
    'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
    /**
     * Drain the owned Session lifecycle and prevent it from reopening until permanent deletion settles.
     * Lifecycle owners must await and return `next()` after draining; a teardown failure aborts deletion.
     * @param request - Session being permanently removed.
     * @param next - continue through remaining lifecycle owners and remove the stored Session.
     * @mode waterfall
     */
    'workspace/session-delete'(request: SessionActivityRequest, next: () => Promise<void>): Promise<void>
    /**
     * Admit optional follow-up work after durable archival and any stop requests.
     * Dispatched inside the registry's write queue: a listener registers its work
     * and returns, and runs the work and any unbounded I/O afterwards. Listener
     * failures are logged without undoing archival. Listeners own and drain their background work.
     * @param request - newly archived Session; repeated archive requests do not dispatch.
     * @mode parallel
     */
    'workspace/session-archived'(request: SessionActivityRequest): Promise<void> | void
    /**
     * Cancel or settle archive follow-up work before making a Session available again.
     * A rejection retains the archived state.
     * @param request - Session about to leave the archive set.
     * @mode parallel
     */
    'workspace/session-unarchiving'(request: SessionActivityRequest): Promise<void> | void
  }
}

interface BootstrapGroup {
  readonly path: string
  readonly headers: SessionHeader[]
  readonly newestAt: number
}

/** Workspace registry launch settings. */
interface Config {
  /** Existing project to register in a Host opened over an SSH tunnel. */
  sshWorkspace?: string
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-cwd header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  /** Whether this Host exposes a project opened over an SSH tunnel. */
  readonly sshProjectHost: boolean

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionPaths = new Map<SessionId, string>()
  private readonly missingSessionPaths = new Set<SessionId>()
  private readonly invalidSessionPaths = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()
  private readonly sshHosts = new Map<string, SshWebHost>()
  private readonly sshStates = new Map<WorkspaceId, SshWorkspaceConnectionState>()
  /** Session-only SSH passwords held strictly in memory; cleared on disconnect and never written to disk. */
  private readonly sshPasswords = new Map<string, string>()
  private readonly sshLifetime = new AbortController()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    verifySsh: path => this.verifySsh(path),
    candidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),
    readSessionHeader: id => this.readSessionHeader(id),
    sessionHeader: (id) => {
      const header = this.headers.get(id)
      /* v8 ignore next 3 -- every path that admits a candidate indexes its header first. */
      if (header === undefined) {
        throw new Error(`workspace member '${id}' has no indexed session header`)
      }
      return header
    },
    rememberSessionPath: (id, path) => {
      this.sessionPaths.set(id, path)
      this.missingSessionPaths.delete(id)
      this.invalidSessionPaths.delete(id)
    },
  }

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'workspaceRegistry')
    if (config.sshWorkspace !== undefined && (typeof config.sshWorkspace !== 'string'
      || !fullyQualifiedWorkspacePath(config.sshWorkspace) || parseSshWorkspacePath(config.sshWorkspace) !== undefined)) {
      throw new TypeError('SSH project mode requires an absolute directory on the machine running the Host')
    }
    this.sshProjectHost = config.sshWorkspace !== undefined
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => async () => {
      this.sshLifetime.abort()
      await Promise.all([...this.sshHosts.values()].map(host => host.close()))
    }, 'workspace.closeSshHosts')
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.listStoredHeaders()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.listStoredHeaders())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    this.rebuildEntities()
    if (this.config.sshWorkspace !== undefined) await this.create(this.config.sshWorkspace)
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace for an existing directory. The fully qualified
   * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
   * non-directory path rejects. Repeated calls for the same canonical path
   * return the existing entity without changing its title.
   * A newly created workspace is prepended to the durable registry order.
   * Different canonical paths may share a display title.
   * @param path - Existing directory to own, in a fully qualified path spelling.
   * @param title - Display title used only when a new record is created.
   * @returns the existing or newly durable workspace.
   */
  // TODO: `title` lost its last production caller when the gateway's
  // create-by-name branch was deleted
  // (.agents/notes/archived/simplification/2026-07-31-one-route-to-add-a-workspace.md);
  // drop the parameter with its @param clause and the `create(path, title?)`
  // lines in this package's README pair.
  async create(path: string, title?: string): Promise<Workspace> {
    if (parseSshWorkspacePath(path) !== undefined) {
      const canonical = await this.verifySsh(path)
      return await this.enqueueOperation(() => this.createCanonical(canonical, title))
    }
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`)
    }
    return await this.enqueueOperation(() => this.createCanonical(canonical, title))
  }

  /**
   * Verify password authentication and adopt an existing remote directory.
   * @param path - Absolute POSIX directory on the SSH host.
   * @param connection - Server coordinates and password for this attempt.
   * @returns The workspace and whether this request registered it.
   */
  async createSsh(path: string, connection: SshWorkspaceConnection): Promise<{ workspace: Workspace; created: boolean }> {
    if (!path.startsWith('/') || path.length > 4096 || path.includes('\0')) {
      throw new Error('Enter an absolute remote directory')
    }
    const authority = sshWorkspaceAuthority(connection)
    const canonical = formatSshWorkspacePath(authority, path)
    const location = parseSshWorkspacePath(canonical)
    if (location === undefined) throw new Error('Invalid SSH workspace location')
    return this.enqueueOperation(async () => {
      const credentials = this.ctx.get('credentials')
      if (credentials === undefined) throw new Error('SSH credential storage is unavailable')
      await credentials.modifyRecord(sshCredentialKey(authority), async (current) => {
        const fingerprint = await probeSshDirectory(connection, location.remotePath, storedSshHost(current)?.fingerprint)
        // Store only host coordinates and pinned fingerprint; passwords stay strictly in memory.
        return { kind: 'grant', payload: { host: connection.host, port: connection.port, username: connection.username, fingerprint } }
      })
      this.sshPasswords.set(authority, connection.password)
      const existing = await this.resolveByPath(canonical)
      if (existing !== undefined) return { workspace: existing, created: false }
      return { workspace: await this.createCanonical(canonical), created: true }
    })
  }

  /**
   * Verify and update an existing SSH workspace's endpoint coordinates, credentials, and remote directory.
   * When password is omitted or blank, the previously saved password for the workspace is reused.
   * @param id - Existing SSH workspace id to update.
   * @param path - New absolute POSIX directory on the SSH host.
   * @param connection - Updated SSH coordinates and optional password.
   * @returns The updated workspace entity.
   */
  async updateSsh(id: WorkspaceId, path: string, connection: SshWorkspaceUpdateConnection): Promise<Workspace> {
    if (!path.startsWith('/') || path.length > 4096 || path.includes('\0')) {
      throw new Error('Enter an absolute remote directory')
    }
    return this.enqueueOperation(async () => {
      const entity = this.entities.get(id)
      const previousLocation = entity === undefined ? undefined : parseSshWorkspacePath(entity.path)
      if (this.sshProjectHost || entity === undefined || previousLocation === undefined) {
        throw new Error('Select a saved SSH workspace to edit')
      }
      const credentials = this.ctx.get('credentials')
      if (credentials === undefined) throw new Error('SSH credential storage is unavailable')
      let password = connection.password
      if (password === undefined || password === '') {
        password = this.sshPasswords.get(previousLocation.host)
      }
      if (password === undefined || password === '') {
        throw new Error('Enter the SSH password to update this connection')
      }
      const resolvedConnection: SshWorkspaceConnection = {
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password,
      }
      const authority = sshWorkspaceAuthority(resolvedConnection)
      const canonical = formatSshWorkspacePath(authority, path)
      const location = parseSshWorkspacePath(canonical)
      if (location === undefined) throw new Error('Invalid SSH workspace location')
      for (const candidate of this.entities.values()) {
        if (candidate.id !== id && candidate.path === canonical) {
          throw new Error('Another workspace already uses this SSH location')
        }
      }
      await credentials.modifyRecord(sshCredentialKey(authority), async (current) => {
        const trustedFingerprint = previousLocation.host === authority ? storedSshHost(current)?.fingerprint : undefined
        const fingerprint = await probeSshDirectory(resolvedConnection, location.remotePath, trustedFingerprint)
        return { kind: 'grant', payload: { host: resolvedConnection.host, port: resolvedConnection.port, username: resolvedConnection.username, fingerprint } }
      })
      this.sshPasswords.delete(previousLocation.host)
      this.sshPasswords.set(authority, password)
      const previousPath = entity.path
      const activeHost = this.sshHosts.get(previousPath)
      if (activeHost !== undefined) {
        this.sshHosts.delete(previousPath)
        await activeHost.close()
        if (this.entities.get(id) === entity) this.reportSshStatus(id, 'paused')
      }
      if (previousPath !== canonical) {
        await entity.setPath(canonical)
      }
      return entity
    })
  }

  /**
   * Open the remote Harness for a registered, password-authenticated Workspace.
   * @param id - local registration selecting the remote project and credentials.
   * @param models - optional handler for authenticated desktop model calls.
   * @returns Local, authenticated URL for the SSH tunnel.
   */
  async openSsh(id: WorkspaceId, models?: import('node:http').RequestListener, passwordOverride?: string): Promise<string> {
    const workspace = this.entities.get(id)
    const location = workspace === undefined ? undefined : parseSshWorkspacePath(workspace.path)
    if (this.sshProjectHost || workspace === undefined || location === undefined) {
      throw new Error('Select a saved SSH workspace on the desktop')
    }
    const record = await this.ctx.get('credentials')?.readRecord(sshCredentialKey(location.host))
    this.sshLifetime.signal.throwIfAborted()
    if (this.entities.get(id) !== workspace) throw new Error('The SSH workspace was removed')
    const hostInfo = storedSshHost(record)
    if (hostInfo === undefined || sshWorkspaceAuthority(hostInfo) !== location.host) {
      throw new Error('Saved SSH host metadata is unavailable. Edit or add the workspace again.')
    }
    if (passwordOverride !== undefined && passwordOverride !== '') {
      this.sshPasswords.set(location.host, passwordOverride)
    }
    let host = this.sshHosts.get(workspace.path)
    if (host === undefined) {
      const password = this.sshPasswords.get(location.host)
      if (password === undefined || password === '') {
        throw new SshPasswordRequiredError(id)
      }
      const login = { ...hostInfo, password }
      const opened = new SshWebHost(login, location.remotePath, process.env.ALTOAIH_SSH_RUNTIME_DIR, models)
      host = opened
      this.sshHosts.set(workspace.path, opened)
      this.reportSshStatus(id, 'connecting')
      void opened.closed.then(() => {
        if (this.sshHosts.get(workspace.path) !== opened) return
        this.sshHosts.delete(workspace.path)
        if (this.entities.get(id) === workspace) this.reportSshStatus(id, 'interrupted')
      })
    }
    try {
      const url = await host.url
      if (this.sshHosts.get(workspace.path) === host) {
        this.reportSshStatus(id, 'connected')
      }
      return url
    } catch (error) {
      if (this.sshHosts.get(workspace.path) === host) {
        this.sshHosts.delete(workspace.path)
        this.sshPasswords.delete(location.host)
        this.reportSshStatus(id, 'interrupted')
      }
      throw error
    }
  }

  /**
   * Read the last reported local carrier state for a saved SSH Workspace.
   * @param id - Saved SSH Workspace identity.
   * @returns the latest reported SSH carrier state, if any.
   */
  sshStatus(id: WorkspaceId): SshWorkspaceConnectionState | undefined {
    return this.sshStates.get(id)
  }

  /**
   * Report a carrier state supplied by an SSH consumer without changing its
   * host ownership. An interrupted API stream can be retried against a still
   * live tunnel, so only the Session router knows that state.
   * @param id - Saved SSH Workspace that owns the carrier.
   * @param state - Current local carrier state.
   */
  reportSshStatus(id: WorkspaceId, state: SshWorkspaceConnectionState): void {
    const workspace = this.entities.get(id)
    if (this.sshProjectHost || workspace === undefined || parseSshWorkspacePath(workspace.path) === undefined) return
    if (this.sshStates.get(id) === state) return
    this.sshStates.set(id, state)
    this.ctx.emit('workspace/ssh-status', id, state)
  }

  /**
   * Stop the local carrier for a saved SSH Workspace after its caller has
   * attempted any remote cleanup it owns. This only pauses the desktop relay;
   * it never asserts that the remote task stopped.
   * @param id - Saved SSH Workspace whose local carrier should close.
   * @returns resolution after local sockets and the SSH transport have closed.
   */
  async closeSsh(id: WorkspaceId): Promise<void> {
    const workspace = this.entities.get(id)
    const location = workspace === undefined ? undefined : parseSshWorkspacePath(workspace.path)
    if (this.sshProjectHost || workspace === undefined || location === undefined) {
      throw new Error('Select a saved SSH workspace on the desktop')
    }
    // Always clear the in-memory password on disconnect so reconnecting prompts again.
    this.sshPasswords.delete(location.host)
    const host = this.sshHosts.get(workspace.path)
    if (host !== undefined) {
      this.sshHosts.delete(workspace.path)
      await host.close()
    }
    if (this.entities.get(id) === workspace) this.reportSshStatus(id, 'paused')
  }

  /** Browse a saved SSH project without waiting for a remote chat host. */
  async browseSsh(id: WorkspaceId, path: string, kind: SshFilesResult['kind'], signal: AbortSignal): Promise<SshFilesResult> {
    const workspace = this.entities.get(id)
    const location = workspace === undefined ? undefined : parseSshWorkspacePath(workspace.path)
    if (this.sshProjectHost || location === undefined) throw new Error('Select a saved SSH workspace')
    const record = await this.ctx.get('credentials')?.readRecord(sshCredentialKey(location.host))
    const hostInfo = storedSshHost(record)
    if (this.entities.get(id) !== workspace) throw new Error('The SSH workspace was removed')
    if (hostInfo === undefined || sshWorkspaceAuthority(hostInfo) !== location.host) throw new Error('Saved SSH host metadata is unavailable')
    const password = this.sshPasswords.get(location.host)
    if (password === undefined || password === '') throw new SshPasswordRequiredError(id)
    return sshFiles({ ...hostInfo, password }, location.remotePath, path, kind, AbortSignal.any([signal, this.sshLifetime.signal]))
  }

  /** Publish visible Session references obtained from this workspace's authenticated runtime. */
  syncSshSessions(id: WorkspaceId, sessions: readonly SessionId[]): Promise<readonly SessionId[]> {
    return this.enqueueOperation(async () => {
      const entity = this.entities.get(id)
      if (this.sshProjectHost || entity === undefined || parseSshWorkspacePath(entity.path) === undefined) return []
      const occupied = new Set(this.list().filter(workspace => workspace.id !== id).flatMap(workspace => workspace.sessionIds))
      await entity.syncSshSessions(sessions.filter(sessionId => !occupied.has(sessionId)))
      return entity.sessionIds
    })
  }

  /** Look up a server-owned Session reference, excluding legacy desktop logs. */
  sshWorkspaceForSession(id: SessionId): Workspace | undefined {
    if (this.headers.has(id)) return undefined
    return this.list().find(workspace => parseSshWorkspacePath(workspace.path) !== undefined && workspace.sessionIds.includes(id))
  }

  private async verifySsh(path: string): Promise<string> {
    const location = parseSshWorkspacePath(path)
    if (location === undefined || !/^[^@]+@.+:\d+$/u.test(location.host)) return verifySshWorkspacePath(path)
    const record = await this.ctx.get('credentials')?.readRecord(sshCredentialKey(location.host))
    const hostInfo = storedSshHost(record)
    if (hostInfo === undefined || sshWorkspaceAuthority(hostInfo) !== location.host) {
      throw new Error('Saved SSH host metadata is unavailable')
    }
    const password = this.sshPasswords.get(location.host)
    if (password === undefined || password === '') {
      throw new Error('Enter the SSH password to connect to this workspace.')
    }
    const canonical = formatSshWorkspacePath(location.host, location.remotePath)
    await probeSshDirectory({ ...hostInfo, password }, location.remotePath, hostInfo.fingerprint)
    return canonical
  }

  /**
   * Initialize the default Workspace only while both the registry and Session
   * history are empty. Repeated requests reuse its durable identity; deleting
   * that registration permanently disables automatic creation.
   * @param resolveDirectory - resolve the absolute directory; called only for
   * eligible creation, inside the registry mutation queue. Missing directories
   * are created recursively before registration, and the initial title is the
   * requested directory's own final segment — not the canonical one, so a
   * symlink at that path does not retitle the Workspace after its target.
   * After resolution, caller cancellation does not roll back creation or registration.
   * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
   */
  initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (state.defaultWorkspaceId !== undefined) return this.entities.get(state.defaultWorkspaceId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('default Workspace initialization requires the Session store')
      if (state.workspaceIds.length > 0 || state.archivedSessionIds.length > 0
        || sessions.list().length > 0 || (await this.listStoredHeaders()).length > 0) return undefined

      const path = await resolveDirectory()
      if (!fullyQualifiedWorkspacePath(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
      await mkdir(path, { recursive: true })
      const canonical = await realpathNormalize(path)
      // A Session can start outside the registry queue while directory preparation awaits I/O.
      if ((await this.listStoredHeaders()).length > 0 || sessions.list().length > 0) return undefined
      return this.createCanonical(canonical, defaultWorkspaceTitle(path), true)
    })
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. Every
   * entity's `sessionIds` getter is already filtered by the startup/live
   * canonical-cwd header index; this method performs no persistence reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Permanently remove one Workspace and its accounted Session logs.
   * For a local Workspace, remove the project directory on disk only when
   * `options.deleteDirectory !== false`. A local directory failure retains the registration.
   * @param id - Workspace identity to remove.
   * @param options - whether active Session work is stopped and whether to delete the local directory on disk.
   * @returns `true` when the Workspace existed.
   */
  deletePermanently(
    id: WorkspaceId,
    options: ArchiveSessionOptions & { readonly deleteDirectory?: boolean } = {},
  ): Promise<boolean> {
    return this.enqueueOperation(async () => {
      const workspace = this.entities.get(id)
      if (workspace === undefined) return false
      const local = parseSshWorkspacePath(workspace.path) === undefined
      if (this.sshProjectHost) return await this.deleteKnown(id)
      if (!local) {
        const references: SessionId[] = []
        for (const sessionId of workspace.sessionIds) {
          if (this.headers.has(sessionId)) await this.deleteSessionKnown(sessionId, options, workspace)
          else references.push(sessionId)
        }
        await this.clearSessionFlags(references)
        const removed = await this.deleteKnown(id)
        if (removed) {
          const sshHost = this.sshHosts.get(workspace.path)
          this.sshHosts.delete(workspace.path)
          if (sshHost !== undefined) void sshHost.close()
          for (const sessionId of references) this.ctx.emit('workspace/ssh-session-hidden', sessionId)
        }
        return removed
      }
      const deleteDirectory = options.deleteDirectory !== false
      if (deleteDirectory) {
        await this.assertDeletableWorkspaceDirectory(workspace.path)
      }
      for (const sessionId of [...workspace.sessionIds]) {
        await this.deleteSessionKnown(sessionId, options, workspace)
      }
      if (deleteDirectory) {
        await this.removeWorkspaceDirectory(workspace.path)
      }
      return await this.deleteKnown(id)
    })
  }

  /**
   * Permanently remove one Session, its Workspace membership, global archive/pin
   * entries and durable storage. Active work is stopped when requested; the
   * owned Session lifecycle drains before storage deletion. Membership is
   * retained if stopping, draining, or deleting storage fails.
   * @param sessionId - Session identity to remove.
   * @param options - whether to stop active work before deletion.
   * @returns `true` when a known Session was permanently removed.
   */
  deleteSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<boolean> {
    return this.enqueueOperation(async () => {
      if (this.sshProjectHost) throw new Error('Session history is preserved in SSH project mode')
      const remote = this.sshWorkspaceForSession(sessionId)
      if (remote !== undefined) {
        await this.clearSessionFlags([sessionId])
        await this.entities.get(remote.id)?.hideSshSession(sessionId)
        this.ctx.emit('workspace/ssh-session-hidden', sessionId)
        return true
      }
      if (!(await this.sessionKnown(sessionId))) return false
      return await this.deleteSessionKnown(sessionId, options)
    })
  }

  private async clearSessionFlags(ids: readonly SessionId[]): Promise<void> {
    const state = this.requireState()
    const removed = new Set(ids)
    const archivedSessionIds = state.archivedSessionIds.filter(id => !removed.has(id))
    const pinnedSessionIds = state.pinnedSessionIds.filter(id => !removed.has(id))
    if (archivedSessionIds.length !== state.archivedSessionIds.length || pinnedSessionIds.length !== state.pinnedSessionIds.length) {
      await this.setState({ ...state, archivedSessionIds, pinnedSessionIds })
    }
  }

  /** Validate exactly one registered non-root, non-home canonical Workspace directory. */
  private async assertDeletableWorkspaceDirectory(path: string): Promise<void> {
    if (!fullyQualifiedWorkspacePath(path) || resolve(path) !== path) {
      throw new Error(`cannot delete Workspace directory '${path}': registration is not a canonical absolute path`)
    }
    const home = await realpath(homedir())
    const root = parse(path).root
    if (path === root || path === home) {
      throw new Error(`cannot delete Workspace directory '${path}': refusing home or filesystem root`)
    }
    const current = await realpath(path)
    if (current !== path) {
      throw new Error(`cannot delete Workspace directory '${path}': path no longer resolves to its registered canonical directory`)
    }
  }

  /** Revalidate and recursively remove a previously accepted Workspace directory. */
  private async removeWorkspaceDirectory(path: string): Promise<void> {
    await this.assertDeletableWorkspaceDirectory(path)
    await rm(path, { recursive: true, force: false })
  }

  /** Permanently remove a known Session while holding the registry operation queue. */
  private async deleteSessionKnown(sessionId: SessionId, options: ArchiveSessionOptions, deletingWorkspace?: Workspace): Promise<boolean> {
    if (options.stopActivity === true) {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } else {
      const activity = await this.ctx.waterfall(
        'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
      )
      if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
    }
    let removed = false
    await this.ctx.waterfall('workspace/session-delete', { sessionId }, async () => {
      await this.ctx.sessionPersistence.delete(sessionId)
      const state = this.requireState()
      for (const workspace of this.entities.values()) {
        if (workspace !== deletingWorkspace && workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
      }
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      this.headers.delete(sessionId)
      this.sessionPaths.delete(sessionId)
      this.missingSessionPaths.delete(sessionId)
      this.invalidSessionPaths.delete(sessionId)
      removed = true
    })
    if (!removed) throw new Error(`session '${sessionId}' deletion was not performed`)
    return true
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches workspace accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * Without `stopActivity` the session must also be inactive: the
   * `workspace/session-activity` waterfall is asked once, and any reported
   * activity rejects with {@link WorkspaceActiveSessionError} before anything
   * is written. With `stopActivity` the archive is written without an
   * activity check, and the `workspace/session-stop` providers are then asked
   * to stop the session's work: the durable archive set is what a provider's
   * `agent/pre-step` gate reads, so every wake the stops induce is already
   * blocked. Archiving drops the session's pin in the same durable write
   * (pinning and archival are mutually exclusive). An already archived id
   * resolves without writing, asking, or stopping.
   * @param sessionId - The session to archive.
   * @param options - Whether running work is stopped instead of refusing.
   * @returns resolution after durability, any stop requests, and follow-up admission.
   */
  archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'archive')
      }
      if (options.stopActivity !== true) {
        const activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        )
        if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
      if (options.stopActivity === true) await this.stopSessionActivity(sessionId)
      try {
        await this.ctx.parallel('workspace/session-archived', { sessionId })
      } catch (error) {
        this.ctx.logger.warn('Session archived, but archive follow-up admission failed: %s', error)
      }
    })
  }

  /**
   * Unarchive one session durably by dropping it from the registry-global
   * archive set; the accounting slot was never touched, so the session
   * returns to its recorded position. Unarchiving runs no session-existence
   * check because removing an id cannot introduce an unknown one, so an
   * entry whose session is gone still resolves. An id that is not archived
   * resolves without writing.
   * @param sessionId - The session to unarchive.
   * @returns resolution after durability.
   */
  unarchiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent archive.
      const state = this.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await this.ctx.parallel('workspace/session-unarchiving', { sessionId })
      await this.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * The registry-global pin set: sessions surfaced ahead of every unpinned
   * session on grouping surfaces. Pinning never touches workspace accounting.
   * @returns Session ids in pin order (most recently pinned first).
   */
  get pinnedSessionIds(): readonly SessionId[] {
    return this.requireState().pinnedSessionIds
  }

  /**
   * Pin one session durably, prepending it to the registry-global pin set.
   * The session must exist (live or in session persistence) and must not be
   * archived. An already pinned id resolves without writing or reordering.
   * @param sessionId - The session to pin.
   * @returns resolution after durability.
   */
  pinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another pin or archive.
      if (this.requireState().pinnedSessionIds.includes(sessionId)) return
      if (this.requireState().archivedSessionIds.includes(sessionId)) {
        throw new WorkspaceArchivedSessionPinError(sessionId)
      }
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId, 'pin')
      }
      const state = this.requireState()
      await this.setState({
        ...state,
        pinnedSessionIds: [sessionId, ...state.pinnedSessionIds],
      })
    })
  }

  /**
   * Unpin one session durably by dropping it from the registry-global pin
   * set. Unpinning runs no session-existence check because removing an id
   * cannot introduce an unknown one, so an entry whose session is gone still
   * resolves. An id that is not pinned resolves without writing.
   * @param sessionId - The session to unpin.
   * @returns resolution after durability.
   */
  unpinSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with a concurrent pin.
      const state = this.requireState()
      if (!state.pinnedSessionIds.includes(sessionId)) return
      await this.setState({
        ...state,
        pinnedSessionIds: state.pinnedSessionIds.filter(id => id !== sessionId),
      })
    })
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.listStoredHeaders())
    return this.headers.has(id)
  }

  /** Request every provider's stop; a failing provider is logged, never a reason to keep the session visible. */
  private async stopSessionActivity(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error: unknown) {
      // ctx.parallel settles every listener and rejects with one AggregateError.
      /* v8 ignore next -- the plain arm guards a rethrowing dispatcher. */
      const failures = error instanceof AggregateError ? error.errors : [error]
      for (const failure of failures) {
        this.ctx.logger.warn(`workspace: stopping session '${sessionId}' for archive failed: ${String(failure)}`)
      }
    }
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. A missing path rejects during `realpath`; an existing unowned
   * directory returns `undefined`.
   * @param path - Existing directory path in a fully qualified spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const canonical = await realpathNormalize(path)
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }
    return undefined
  }

  private async createCanonical(canonical: string, title?: string, firstUse = false): Promise<WorkspaceEntity> {
    for (const entity of this.entities.values()) {
      if (entity.path === canonical) return entity
    }

    const workspaceName = title ?? defaultWorkspaceTitle(canonical)
    const table = this.requireTable()
    const state = this.requireState()
    const id = brandString<WorkspaceId>(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: canonical,
      title: workspaceName,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        ...state,
        pendingMutation: undefined,
        initialized: true,
        ...(firstUse ? { defaultWorkspaceId: id } : {}),
        workspaceIds: [id, ...state.workspaceIds],
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      ...state,
      pendingMutation: undefined,
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from its shape alone.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    await this.setState({ ...state, pendingMutation: undefined })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByPath = new Map<string, SessionHeader[]>()
    for (const header of headers) {
      const path = this.sessionPaths.get(header.id)
      if (path === undefined) continue
      const group = groupsByPath.get(path)
      if (group === undefined) groupsByPath.set(path, [header])
      else group.push(header)
    }
    const groups: BootstrapGroup[] = [...groupsByPath].map(([path, groupHeaders]) => {
      groupHeaders.sort(compareHeaders)
      const newest = groupHeaders[0] as SessionHeader
      return { path, headers: groupHeaders, newestAt: newest.createdAt }
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.path.localeCompare(right.path))

    const byPath = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byPath.set(record.path, id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      let id = byPath.get(group.path)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = brandString<WorkspaceId>(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.path,
          title: defaultWorkspaceTitle(group.path),
          sessionIds,
          createdAt,
          updatedAt: createdAt,
        }
        await table.put(id, record)
        byPath.set(group.path, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [group.path, group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(left.path) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(right.path) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({
        initialized: false,
        workspaceIds,
        archivedSessionIds: state.archivedSessionIds,
        pinnedSessionIds: state.pinnedSessionIds,
      })
    }
    await this.setState({
      initialized: true,
      workspaceIds,
      archivedSessionIds: state.archivedSessionIds,
      pinnedSessionIds: state.pinnedSessionIds,
    })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const paths = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const pathHolder = paths.get(record.path)
      if (pathHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: path '${record.path}' is claimed `
          + `by both workspace '${pathHolder}' and workspace '${id}'`,
        )
      }
      paths.set(record.path, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionPaths.clear()
    this.missingSessionPaths.clear()
    this.invalidSessionPaths.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionPaths.delete(header.id)
    this.missingSessionPaths.delete(header.id)
    if (header.cwd === undefined) {
      this.invalidSessionPaths.set(header.id, 'header has no cwd')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (parseSshWorkspacePath(path) === undefined && !(await stat(path)).isDirectory()) {
        this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionPaths.set(header.id, path)
      this.invalidSessionPaths.delete(header.id)
    } catch (error) {
      if (fullyQualifiedWorkspacePath(header.cwd)
        && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.missingSessionPaths.add(header.id)
      }
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  /** Every stored session's header, projected from the persistence snapshot listing. */
  private async listStoredHeaders(): Promise<SessionHeader[]> {
    const snapshots = await this.ctx.sessionPersistence.list()
    return snapshots.map(snapshot => snapshot.header)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      if (parseSshWorkspacePath(entity.path) !== undefined) continue
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        if (this.host.candidateMatches(sessionId, record.path)) continue
        const path = this.sessionPaths.get(sessionId)
        const reason = this.invalidSessionPaths.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical cwd '${path}' differs from workspace path '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.listStoredHeaders()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry
