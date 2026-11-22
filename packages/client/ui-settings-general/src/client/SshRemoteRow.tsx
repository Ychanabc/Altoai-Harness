/** General Settings control: add an SSH remote directory as a workspace. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductChromeInjected } from './product-chrome-types.ts'
import type { createProductChromeStore } from './product-chrome-store.ts'
import css from './SshRemoteRow.module.css'

/** Row props: chrome store plus locale. */
export type SshRemoteRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsStore<ReturnType<typeof createProductChromeStore>>
  & PropsLocale<'settings'>
  & InjectFace<ProductChromeInjected>

/**
 * Render the SSH remote workspace row.
 * @param props - accepted preference, writers and localized copy.
 * @returns the General Settings row.
 */
export function SshRemoteRow({
  useStore, setSshHost, setSshWorkspace, addSshWorkspace, t,
}: SshRemoteRowProps) {
  const host = useStore(s => s.sshHost)
  const workspace = useStore(s => s.sshWorkspace)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    setBusy(true)
    setError(null)
    void addSshWorkspace().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }
  return (
    <div className={css.block} role="group" aria-label={t('ssh.title')}>
      <div className={css.row}>
        <div>
          <div className={css.title}>{t('ssh.title')}</div>
          <div className={css.description}>{t('ssh.description')}</div>
        </div>
      </div>
      <label className={css.field}>
        <span>{t('ssh.host')}</span>
        <input
          value={host}
          placeholder={t('ssh.host.placeholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setSshHost(event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span>{t('ssh.workspace')}</span>
        <input
          value={workspace}
          placeholder={t('ssh.workspace.placeholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setSshWorkspace(event.target.value) }}
        />
      </label>
      <div className={css.actions}>
        <Button variant="primary" disabled={busy || host.trim() === '' || workspace.trim() === ''} onClick={add}>
          {t('ssh.add')}
        </Button>
      </div>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </div>
  )
}
