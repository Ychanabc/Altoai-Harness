/** General Settings control: add and edit SSH remote directories as workspaces. */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceCreateRequest, WorkspaceId, WorkspaceSnapshot, WorkspaceSource, WorkspaceUpdateSshRequest, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SshRemoteRow.module.css'

interface ParsedSshWorkspace {
  readonly workspace: WorkspaceView
  readonly host: string
  readonly port: number
  readonly username: string
  readonly remotePath: string
  readonly authority: string
}

const SSH_WORKSPACE_PATH_RE =
  /^ssh:\/\/((?:[a-zA-Z0-9_.%-]+@)?(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:.]+\])(?::[0-9]+)?)(\/[^\0]*)$/u

function parseSavedSshWorkspace(workspace: WorkspaceView): ParsedSshWorkspace | undefined {
  const pathMatch = SSH_WORKSPACE_PATH_RE.exec(workspace.path)
  if (pathMatch === null || pathMatch[0] !== workspace.path) return undefined
  const [, authority, remotePath] = pathMatch
  if (authority === undefined || remotePath === undefined) return undefined
  const authMatch = /^(?:([a-zA-Z0-9_.%-]+)@)?(\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9_][a-zA-Z0-9_.-]*)(?::([0-9]+))?$/u.exec(authority)
  if (authMatch === null) return undefined
  const [, rawUser = '', rawHost, rawPort] = authMatch
  if (rawHost === undefined) return undefined
  let username = rawUser
  try {
    username = decodeURIComponent(rawUser)
  } catch (_invalidEncoding) {
    // Keep raw segment if a saved alias contains an unescaped percent character.
    username = rawUser
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const port = rawPort === undefined ? 22 : Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { workspace, host, port, username, remotePath, authority }
}

/** Row props: saved workspaces hook, SSH create/update mutations, and localized copy. */
export type SshRemoteRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'>
  & Omit<InjectFace<{
    hooks: { workspaces: WorkspaceSource & HostObservable<WorkspaceSnapshot> }
    addSshWorkspace: (input: WorkspaceCreateRequest) => Promise<unknown>
    updateSshWorkspace: (input: WorkspaceUpdateSshRequest) => Promise<unknown>
  }>, 'hooks'>
  & PropsHooks<{ workspaces: HostObservable<WorkspaceSnapshot> }>

/**
 * Render the SSH remote workspace management row (list + edit + create).
 * @param props - saved workspaces, SSH writers, and localized copy.
 * @returns the General Settings row.
 */
export function SshRemoteRow({
  useWorkspaces, addSshWorkspace, updateSshWorkspace, t,
}: SshRemoteRowProps) {
  const items = useWorkspaces(snapshot => snapshot.items)
  const savedSsh = useMemo(
    () => items.flatMap((item) => {
      const parsed = parseSavedSshWorkspace(item)
      return parsed === undefined ? [] : [parsed]
    }),
    [items],
  )
  const [editingId, setEditingId] = useState<WorkspaceId | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const editing = editingId !== null
  const portNumber = Number(port)
  const valid = host.trim() !== '' && username.trim() !== '' && (editing || password !== '')
    && workspace.trim().startsWith('/') && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535

  const startEdit = (entry: ParsedSshWorkspace): void => {
    if (busy) return
    setEditingId(entry.workspace.workspaceId)
    setEditingTitle(entry.workspace.title)
    setHost(entry.host)
    setPort(String(entry.port))
    setUsername(entry.username)
    setPassword('')
    setWorkspace(entry.remotePath)
    setError(null)
    setStatusMessage(null)
  }

  const cancelEdit = (): void => {
    if (busy) return
    setEditingId(null)
    setEditingTitle('')
    setHost('')
    setPort('22')
    setUsername('')
    setPassword('')
    setWorkspace('')
    setError(null)
    setStatusMessage(null)
  }

  const submit = (): void => {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    setStatusMessage(null)
    if (editingId !== null) {
      void updateSshWorkspace({
        workspaceId: editingId,
        path: workspace.trim(),
        ssh: {
          host: host.trim(),
          port: portNumber,
          username: username.trim(),
          ...(password === '' ? {} : { password }),
        },
      }).then(() => {
        setEditingId(null)
        setEditingTitle('')
        setHost('')
        setPort('22')
        setUsername('')
        setWorkspace('')
        setStatusMessage(t('ssh.updated'))
      }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => { setPassword(''); setBusy(false) })
      return
    }
    void addSshWorkspace({
      path: workspace.trim(),
      ssh: { host: host.trim(), port: portNumber, username: username.trim(), password },
    }).then(() => {
      setStatusMessage(t('ssh.created'))
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setPassword(''); setBusy(false) })
  }

  return (
    <div className={css.block} role="group" aria-label={t('ssh.title')}>
      <div className={css.row}>
        <div>
          <div className={css.title}>{t('ssh.title')}</div>
          <div className={css.description}>{editing ? t('ssh.editHint') : t('ssh.connectionHint')}</div>
        </div>
      </div>

      {savedSsh.length > 0 && (
        <div className={css.savedList}>
          <div className={css.savedHeader}>{t('ssh.savedTitle')}</div>
          {savedSsh.map((entry) => {
            const active = entry.workspace.workspaceId === editingId
            return (
              <div key={entry.workspace.workspaceId} className={clsx(css.savedCard, active && css.savedCardActive)}>
                <div className={css.savedMeta}>
                  <div className={css.savedName}>{entry.workspace.title}</div>
                  <div className={css.savedEndpoint}>
                    <span className={css.savedBadge}>{entry.username}@{entry.host}:{entry.port}</span>
                    <span className={css.savedPath}>{entry.remotePath}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={active ? 'primary' : 'outline'}
                  disabled={busy}
                  onClick={() => { if (active) cancelEdit(); else startEdit(entry) }}
                >
                  {t(active ? 'ssh.cancelEdit' : 'ssh.edit')}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <div className={css.editingBanner}>{t('ssh.editingLabel', { name: editingTitle })}</div>
      )}

      <div className={css.formGrid}>
        <label className={css.field}>
          <span>{t('ssh.ip')}</span>
          <input
            value={host}
            placeholder="192.0.2.10"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { setHost(event.target.value) }}
          />
        </label>
        <label className={css.field}>
          <span>{t('ssh.port')}</span>
          <input type="number" min="1" max="65535" value={port} disabled={busy} onChange={(event) => { setPort(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span>{t('ssh.username')}</span>
          <input autoComplete="username" spellCheck={false} value={username} disabled={busy} onChange={(event) => { setUsername(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span>{t('ssh.password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder={editing ? t('ssh.passwordPlaceholder') : undefined}
            value={password}
            disabled={busy}
            onChange={(event) => { setPassword(event.target.value) }}
          />
        </label>
        <label className={clsx(css.field, css.fieldFull)}>
          <span>{t('ssh.workspace')}</span>
          <input
            value={workspace}
            placeholder={t('ssh.workspace.placeholder')}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { setWorkspace(event.target.value) }}
          />
        </label>
      </div>

      <div className={css.actions}>
        {editing && (
          <Button variant="outline" disabled={busy} onClick={cancelEdit}>
            {t('ssh.cancelEdit')}
          </Button>
        )}
        <Button variant="primary" disabled={busy || !valid} onClick={submit}>
          {t(busy ? (editing ? 'ssh.saving' : 'ssh.connecting') : (editing ? 'ssh.save' : 'ssh.add'))}
        </Button>
      </div>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {statusMessage !== null && <div className={css.status} role="status">{statusMessage}</div>}
    </div>
  )
}
