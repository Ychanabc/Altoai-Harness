/** Local disk cache for SSH Workspace session summaries and conversation history. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  SessionEventsPage,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionHistoryRecord,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionsValue,
  SessionProjectionValues,
  SessionState,
  SessionSummary,
  SessionWireHeader,
} from './types.ts'

/** Persisted snapshot and event window for one SSH Session. */
export interface CachedSshSession {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly header: SessionWireHeader
  readonly cursor: number
  readonly hasMore: boolean
  readonly records: readonly SessionHistoryRecord[]
  readonly projections: SessionProjectionBaseline
  readonly updatedAt: number
}

interface StoredWorkspaceSummaries {
  readonly workspaceId: string
  readonly updatedAt: number
  readonly summaries: readonly SessionSummary[]
}

interface StoredPausedState {
  readonly workspaces: readonly string[]
}

function keyHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function defaultCacheRoot(): string {
  const configured = process.env.ALTOAIH_SSH_CACHE_DIR?.trim()
  if (configured !== undefined && configured !== '') return configured
  return join(homedir(), '.dsh', 'ssh-cache')
}

/** Merge two record arrays by `event.seq`, returning a sorted contiguous suffix ending at the highest seq. */
function mergeContiguousRecords(
  existing: readonly SessionHistoryRecord[],
  incoming: readonly SessionHistoryRecord[],
): SessionHistoryRecord[] {
  if (existing.length === 0) return contiguousTail([...incoming].sort((a, b) => a.event.seq - b.event.seq))
  if (incoming.length === 0) return contiguousTail([...existing].sort((a, b) => a.event.seq - b.event.seq))
  const bySeq = new Map<number, SessionHistoryRecord>()
  for (const record of existing) bySeq.set(record.event.seq, record)
  for (const record of incoming) bySeq.set(record.event.seq, record)
  const sorted = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq)
  return contiguousTail(sorted)
}

function contiguousTail(sorted: readonly SessionHistoryRecord[]): SessionHistoryRecord[] {
  if (sorted.length <= 1) return [...sorted]
  let start = sorted.length - 1
  while (start > 0) {
    const prev = sorted[start - 1]
    const curr = sorted[start]
    if (prev === undefined || curr === undefined || prev.event.seq + 1 !== curr.event.seq) break
    start--
  }
  return sorted.slice(start)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHistoryRecord(value: unknown): value is SessionHistoryRecord {
  if (!isObjectRecord(value) || value.type !== 'event') return false
  const event = value.event
  return isObjectRecord(event)
    && typeof event.type === 'string'
    && typeof event.seq === 'number'
    && Number.isFinite(event.seq)
    && typeof event.time === 'number'
}

/**
 * Local durable mirror of SSH conversation lists, histories, and pause states.
 * Enables Cursor-style offline browsing when SSH is disconnected and instant
 * cold-start sidebar hydration before any remote tunnel is opened.
 */
export class SshLocalCache {
  private readonly rootDir: string
  private readonly summariesMemory = new Map<WorkspaceId, readonly SessionSummary[]>()
  private readonly sessionsMemory = new Map<SessionId, CachedSshSession | null>()
  private readonly commandsMemory = new Map<WorkspaceId, readonly unknown[]>()
  private readonly writeQueue = new Map<string, Promise<void>>()
  private readonly pendingDebouncedWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; payload: unknown }>()
  private pausedLoaded = false
  private pausedSet = new Set<WorkspaceId>()

  /** @param baseDir - optional cache directory override (primarily for isolated tests). */
  constructor(baseDir?: string) {
    this.rootDir = baseDir ?? defaultCacheRoot()
  }

  /** Load the persisted set of user-paused SSH Workspace IDs. */
  loadPausedWorkspaces(): Set<WorkspaceId> {
    if (this.pausedLoaded) return new Set(this.pausedSet)
    this.pausedLoaded = true
    const parsed = this.readJsonSync<StoredPausedState>(this.pausedPath())
    if (parsed !== undefined && Array.isArray(parsed.workspaces)) {
      for (const id of parsed.workspaces) {
        if (typeof id === 'string' && id.length > 0) {
          this.pausedSet.add(brandString<WorkspaceId>(id))
        }
      }
    }
    return new Set(this.pausedSet)
  }

  /** Persist the current set of user-paused SSH Workspace IDs. */
  savePausedWorkspaces(workspaces: ReadonlySet<WorkspaceId>): void {
    this.pausedLoaded = true
    this.pausedSet = new Set(workspaces)
    this.enqueueWrite(this.pausedPath(), { workspaces: [...workspaces] })
  }

  /** Read cached summaries for a Workspace (memory-first, falling back to disk). */
  getSummaries(workspaceId: WorkspaceId): readonly SessionSummary[] {
    const cached = this.summariesMemory.get(workspaceId)
    if (cached !== undefined) return cached
    const stored = this.readJsonSync<StoredWorkspaceSummaries>(this.summariesPath(workspaceId))
    const summaries = stored !== undefined && Array.isArray(stored.summaries)
      ? stored.summaries.map(item => ({
        ...item,
        sessionId: brandString<SessionId>(String(item.sessionId)),
        running: false,
        agentAvailable: false,
      }))
      : []
    this.summariesMemory.set(workspaceId, summaries)
    return summaries
  }

  /** Save summaries for a Workspace in memory and asynchronously on disk. */
  setSummaries(workspaceId: WorkspaceId, summaries: readonly SessionSummary[]): void {
    this.summariesMemory.set(workspaceId, summaries)
    this.enqueueWrite(this.summariesPath(workspaceId), {
      workspaceId,
      updatedAt: Date.now(),
      summaries: summaries.map(item => ({ ...item, running: false })),
    })
  }

  /** Cache command descriptors for a Workspace so `+` menu works even while offline. */
  setCommands(workspaceId: WorkspaceId, commands: readonly unknown[]): void {
    this.commandsMemory.set(workspaceId, commands)
    this.enqueueWrite(this.commandsPath(workspaceId), commands)
  }

  /** Read cached command descriptors for a Workspace (empty array when never cached). */
  getCommands(workspaceId: WorkspaceId): readonly unknown[] {
    const cached = this.commandsMemory.get(workspaceId)
    if (cached !== undefined) return cached
    const stored = this.readJsonSync<unknown[]>(this.commandsPath(workspaceId))
    const list = Array.isArray(stored) ? stored : []
    this.commandsMemory.set(workspaceId, list)
    return list
  }

  /** Read one cached SSH Session record from memory or disk. */
  getSession(sessionId: SessionId): CachedSshSession | undefined {
    const cached = this.sessionsMemory.get(sessionId)
    if (cached !== undefined) return cached ?? undefined
    const stored = this.readJsonSync<CachedSshSession>(this.sessionPath(sessionId))
    if (stored === undefined || !isObjectRecord(stored) || !Array.isArray(stored.records)) {
      this.sessionsMemory.set(sessionId, null)
      return undefined
    }
    const validRecords = contiguousTail(
      stored.records.filter(isHistoryRecord).sort((a, b) => a.event.seq - b.event.seq),
    )
    const normalized: CachedSshSession = {
      sessionId: brandString<SessionId>(String(stored.sessionId ?? sessionId)),
      workspaceId: brandString<WorkspaceId>(String(stored.workspaceId ?? '')),
      header: {
        ...stored.header,
        id: brandString<SessionId>(String(stored.header?.id ?? sessionId)),
      },
      cursor: typeof stored.cursor === 'number' && Number.isFinite(stored.cursor)
        ? stored.cursor
        : (validRecords.at(-1)?.event.seq ?? -1),
      hasMore: stored.hasMore === true,
      records: validRecords,
      projections: isObjectRecord(stored.projections) && isObjectRecord(stored.projections.values)
        ? {
          asOfSeq: typeof stored.projections.asOfSeq === 'number' ? stored.projections.asOfSeq : -1,
          values: stored.projections.values,
        }
        : { asOfSeq: -1, values: {} },
      updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : Date.now(),
    }
    this.sessionsMemory.set(sessionId, normalized)
    return normalized
  }

  /** Record a live `session/follow` snapshot or event frame into the local cache. */
  recordFollowFrame(workspace: Workspace, sessionId: SessionId, frame: unknown): void {
    if (!isObjectRecord(frame)) return
    if (frame.type === 'snapshot') {
      const records = Array.isArray(frame.records) ? frame.records.filter(isHistoryRecord) : []
      const existing = this.getSession(sessionId)
      const mergedRecords = mergeContiguousRecords(existing?.records ?? [], records)
      const frameCursor = typeof frame.cursor === 'number' && Number.isFinite(frame.cursor)
        ? frame.cursor
        : (mergedRecords.at(-1)?.event.seq ?? -1)
      const incomingProjections = isObjectRecord(frame.projections) && isObjectRecord(frame.projections.values)
        ? {
          asOfSeq: typeof frame.projections.asOfSeq === 'number' ? frame.projections.asOfSeq : -1,
          values: frame.projections.values as SessionProjectionBaseline['values'],
        }
        : undefined
      const projections = selectNewerProjections(existing?.projections, incomingProjections)
      const rawHeader = isObjectRecord(frame.header) ? frame.header : undefined
      const header: SessionWireHeader = rawHeader !== undefined
        ? {
          version: typeof rawHeader.version === 'number' ? rawHeader.version : 1,
          id: sessionId,
          createdAt: typeof rawHeader.createdAt === 'number' ? rawHeader.createdAt : Date.now(),
          cwd: workspace.path,
          ...(typeof rawHeader.parentSession === 'string'
            ? { parentSession: brandString<SessionId>(rawHeader.parentSession) }
            : {}),
          isSeeded: rawHeader.isSeeded === true,
          ...(rawHeader.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
          ...(typeof rawHeader.delegationDepth === 'number' ? { delegationDepth: rawHeader.delegationDepth } : {}),
          ...(typeof rawHeader.agentPreset === 'string' ? { agentPreset: rawHeader.agentPreset } : {}),
        }
        : existing?.header ?? defaultHeader(workspace, sessionId)
      const next: CachedSshSession = {
        sessionId,
        workspaceId: workspace.id,
        header,
        cursor: Math.max(frameCursor, mergedRecords.at(-1)?.event.seq ?? -1),
        hasMore: frame.hasMore === true,
        records: mergedRecords,
        projections,
        updatedAt: Date.now(),
      }
      this.saveSession(next)
      return
    }
    if (isHistoryRecord(frame)) {
      const existing = this.getSession(sessionId)
      const mergedRecords = mergeContiguousRecords(existing?.records ?? [], [frame])
      const nextCursor = Math.max(existing?.cursor ?? -1, frame.event.seq)
      const next: CachedSshSession = {
        sessionId,
        workspaceId: workspace.id,
        header: existing?.header ?? defaultHeader(workspace, sessionId),
        cursor: nextCursor,
        hasMore: existing?.hasMore ?? false,
        records: mergedRecords,
        projections: existing?.projections ?? { asOfSeq: -1, values: {} },
        updatedAt: Date.now(),
      }
      this.saveSession(next)
    }
  }

  /** Record a `session/page` or `session/events` response into the local cache. */
  recordPage(workspace: Workspace, sessionId: SessionId, value: unknown): void {
    if (!isObjectRecord(value) || !Array.isArray(value.records)) return
    const records = value.records.filter(isHistoryRecord)
    if (records.length === 0) return
    const existing = this.getSession(sessionId)
    const mergedRecords = mergeContiguousRecords(existing?.records ?? [], records)
    const pageCursor = typeof value.cursor === 'number' && Number.isFinite(value.cursor)
      ? value.cursor
      : (mergedRecords.at(-1)?.event.seq ?? -1)
    const next: CachedSshSession = {
      sessionId,
      workspaceId: workspace.id,
      header: existing?.header ?? defaultHeader(workspace, sessionId),
      cursor: Math.max(existing?.cursor ?? -1, pageCursor, mergedRecords.at(-1)?.event.seq ?? -1),
      hasMore: existing?.hasMore ?? (value.hasMore === true),
      records: mergedRecords,
      projections: existing?.projections ?? { asOfSeq: -1, values: {} },
      updatedAt: Date.now(),
    }
    this.saveSession(next)
  }

  /** Record a `session/projections` response into the local cache. */
  recordProjections(workspace: Workspace, sessionId: SessionId, value: unknown): void {
    if (!isObjectRecord(value) || value.kind !== 'sequenced' || !isObjectRecord(value.values)) return
    const incoming: SessionProjectionBaseline = {
      asOfSeq: typeof value.asOfSeq === 'number' ? value.asOfSeq : -1,
      values: value.values as SessionProjectionBaseline['values'],
    }
    const existing = this.getSession(sessionId)
    const projections = selectNewerProjections(existing?.projections, incoming)
    const next: CachedSshSession = {
      sessionId,
      workspaceId: workspace.id,
      header: existing?.header ?? defaultHeader(workspace, sessionId),
      cursor: existing?.cursor ?? -1,
      hasMore: existing?.hasMore ?? false,
      records: existing?.records ?? [],
      projections,
      updatedAt: Date.now(),
    }
    this.saveSession(next)
  }

  /** Build a valid `session/follow` opening snapshot from locally cached data without touching SSH. */
  buildOfflineSnapshot(
    workspace: Workspace,
    sessionId: SessionId,
    request?: Partial<SessionFollowRequest>,
  ): Extract<SessionFollowFrame, { type: 'snapshot' }> {
    const cached = this.getSession(sessionId)
    const summary = this.getSummaries(workspace.id).find(item => item.sessionId === sessionId)
    const header = cached?.header ?? defaultHeader(workspace, sessionId, summary?.updatedAt)
    const records = cached === undefined ? [] : contiguousTail(cached.records)
    const lastRecord = records.at(-1)
    const cursor = lastRecord !== undefined ? lastRecord.event.seq : (cached?.cursor ?? -1)
    const rawValues = cached !== undefined
      ? cached.projections.values
      : toProjectionValues(summary?.projections?.values)
    const values = withOfflineModelSelection(rawValues)
    const projections: SessionProjectionBaseline = {
      asOfSeq: cached !== undefined ? cached.projections.asOfSeq : (summary?.projections?.asOfSeq ?? -1),
      values,
    }
    return {
      type: 'snapshot',
      header,
      cursor,
      records,
      // Keep hasMore=false while offline so scrolling up does not trigger remote page failures.
      hasMore: false,
      projections,
      ...(request?.assistantStream === true ? { assistantStream: { revision: 0 } } : {}),
    }
  }

  /** Build a `session/page` or `session/events` response from locally cached records. */
  buildOfflinePage(
    sessionId: SessionId,
    request?: Partial<SessionPageRequest>,
  ): SessionEventsPage {
    const cached = this.getSession(sessionId)
    const all = cached === undefined ? [] : contiguousTail(cached.records)
    const filtered = all.filter((record) => {
      if (request?.beforeSeq !== undefined && record.event.seq >= request.beforeSeq) return false
      if (request?.throughSeq !== undefined && record.event.seq > request.throughSeq) return false
      return true
    })
    const records = contiguousTail(filtered)
    const cursor = request?.throughSeq ?? cached?.cursor ?? (records.at(-1)?.event.seq ?? -1)
    return { records, hasMore: false, cursor }
  }

  /** Build a `session/projections` response from locally cached state. */
  buildOfflineProjections(workspace: Workspace, sessionId: SessionId): SessionProjectionsValue {
    const cached = this.getSession(sessionId)
    if (cached !== undefined) {
      return { kind: 'sequenced', asOfSeq: cached.projections.asOfSeq, values: withOfflineModelSelection(cached.projections.values) }
    }
    const summary = this.getSummaries(workspace.id).find(item => item.sessionId === sessionId)
    if (summary?.projections !== undefined) {
      return {
        kind: 'sequenced',
        asOfSeq: summary.projections.asOfSeq,
        values: withOfflineModelSelection(toProjectionValues(summary.projections.values)),
      }
    }
    return { kind: 'sequenced', asOfSeq: -1, values: withOfflineModelSelection({}) }
  }

  /** Build an idle `session/state` response from locally cached state. */
  buildOfflineState(sessionId: SessionId): SessionState {
    const cached = this.getSession(sessionId)
    return {
      cursor: cached?.cursor ?? -1,
      active: false,
      running: false,
      queue: null,
      pendingInput: [],
    }
  }

  /** Flush all queued async disk writes (useful during dispose and tests). */
  async flush(): Promise<void> {
    for (const [filePath, entry] of [...this.pendingDebouncedWrites]) {
      clearTimeout(entry.timer)
      this.pendingDebouncedWrites.delete(filePath)
      this.enqueueWrite(filePath, entry.payload)
    }
    await Promise.allSettled([...this.writeQueue.values()])
  }

  /** Remove cached files for one Session when deleted. */
  deleteSession(sessionId: SessionId): void {
    this.sessionsMemory.set(sessionId, null)
    const filePath = this.sessionPath(sessionId)
    const pending = this.pendingDebouncedWrites.get(filePath)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pendingDebouncedWrites.delete(filePath)
    }
    try {
      rmSync(filePath, { force: true })
    } catch (_deleteFailed) {
      // Cache removal is best-effort; missing files or locks are harmless.
    }
  }

  private saveSession(session: CachedSshSession): void {
    this.sessionsMemory.set(session.sessionId, session)
    const filePath = this.sessionPath(session.sessionId)
    const existing = this.pendingDebouncedWrites.get(filePath)
    if (existing !== undefined) clearTimeout(existing.timer)
    // Debounce multi-megabyte session snapshots during streaming so UI stays responsive.
    const timer = setTimeout(() => {
      const current = this.pendingDebouncedWrites.get(filePath)
      if (current === undefined) return
      this.pendingDebouncedWrites.delete(filePath)
      this.enqueueWrite(filePath, current.payload)
    }, 500)
    timer.unref()
    this.pendingDebouncedWrites.set(filePath, { timer, payload: session })
  }

  private pausedPath(): string {
    return join(this.rootDir, 'paused.json')
  }

  private summariesPath(workspaceId: WorkspaceId): string {
    return join(this.rootDir, 'workspaces', `${keyHash(workspaceId)}.summaries.json`)
  }

  private commandsPath(workspaceId: WorkspaceId): string {
    return join(this.rootDir, 'workspaces', `${keyHash(workspaceId)}.commands.json`)
  }

  private sessionPath(sessionId: SessionId): string {
    return join(this.rootDir, 'sessions', `${keyHash(sessionId)}.json`)
  }

  private readJsonSync<T>(filePath: string): T | undefined {
    try {
      const raw = readFileSync(filePath, 'utf8')
      return JSON.parse(raw) as T
    } catch (_readFailed) {
      // Missing or unreadable cache entries fall back cleanly to empty state.
      return undefined
    }
  }

  private enqueueWrite(filePath: string, payload: unknown): void {
    const previous = this.writeQueue.get(filePath) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const dir = dirname(filePath)
        await mkdir(dir, { recursive: true })
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
        await writeFile(tempPath, JSON.stringify(payload), 'utf8')
        await rename(tempPath, filePath)
      })
      .catch((_writeError) => {
        // Local cache persistence is best-effort and must never fail foreground RPCs.
      })
    this.writeQueue.set(filePath, next)
    void next.finally(() => {
      if (this.writeQueue.get(filePath) === next) this.writeQueue.delete(filePath)
    })
  }
}

function toProjectionValues(raw: object | undefined): SessionProjectionValues {
  if (raw === undefined) return {}
  return JSON.parse(JSON.stringify(raw)) as SessionProjectionValues
}

function withOfflineModelSelection(values: SessionProjectionValues): SessionProjectionValues {
  if (values.modelSelection !== undefined) return values
  return toProjectionValues({ ...values, modelSelection: { next: null, lastUsed: null } })
}

function selectNewerProjections(
  existing: SessionProjectionBaseline | undefined,
  incoming: SessionProjectionBaseline | undefined,
): SessionProjectionBaseline {
  if (incoming === undefined) return existing ?? { asOfSeq: -1, values: {} }
  if (existing === undefined) return incoming
  return incoming.asOfSeq >= existing.asOfSeq ? incoming : existing
}

function defaultHeader(workspace: Workspace, sessionId: SessionId, createdAt?: number): SessionWireHeader {
  return {
    version: 1,
    id: sessionId,
    createdAt: createdAt ?? Date.now(),
    cwd: workspace.path,
    isSeeded: false,
  }
}

/** Ensure the cache root exists synchronously when tests pre-seed files. */
export function ensureCacheDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
