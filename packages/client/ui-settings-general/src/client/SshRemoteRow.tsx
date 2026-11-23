/** General Settings control: add an SSH remote directory as a workspace. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceCreateRequest } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SshRemoteRow.module.css'

/** Row props: workspace creation and localized copy. */
export type SshRemoteRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'>
  & InjectFace<{ addSshWorkspace: (input: WorkspaceCreateRequest) => Promise<unknown> }>

/**
 * Render the SSH remote workspace row.
 * @param props - accepted preference, writers and localized copy.
 * @returns the General Settings row.
 */
export function SshRemoteRow({
  addSshWorkspace, t,
}: SshRemoteRowProps) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState(false)
  const portNumber = Number(port)
  const valid = host.trim() !== '' && username.trim() !== '' && password !== ''
    && workspace.trim().startsWith('/') && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const add = (): void => {
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    setCreated(false)
    void addSshWorkspace({
      path: workspace.trim(),
      ssh: { host: host.trim(), port: portNumber, username: username.trim(), password },
    }).then(() => { setCreated(true) }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setPassword(''); setBusy(false) })
  }
  return (
    <div className={css.block} role="group" aria-label={t('ssh.title')}>
      <div className={css.row}>
        <div>
          <div className={css.title}>{t('ssh.title')}</div>
          <div className={css.description}>{t('ssh.connectionHint')}</div>
        </div>
      </div>
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
        <input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => { setPassword(event.target.value) }} />
      </label>
      <label className={css.field}>
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
      <div className={css.actions}>
        <Button variant="primary" disabled={busy || !valid} onClick={add}>
          {t(busy ? 'ssh.connecting' : 'ssh.add')}
        </Button>
      </div>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {created && <div className={css.description} role="status">{t('ssh.created')}</div>}
    </div>
  )
}
