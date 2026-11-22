/** General Settings control for SSH remote project execution. */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
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
 * Render the SSH remote service row.
 * @param props - accepted preference, writers and localized copy.
 * @returns the General Settings row.
 */
export function SshRemoteRow({
  useStore, setSshEnabled, setSshHost, setSshWorkspace, t,
}: SshRemoteRowProps) {
  const enabled = useStore(s => s.sshEnabled)
  const host = useStore(s => s.sshHost)
  const workspace = useStore(s => s.sshWorkspace)
  return (
    <div className={css.block} role="group" aria-label={t('ssh.title')}>
      <div className={css.row}>
        <div>
          <div className={css.title}>{t('ssh.title')}</div>
          <div className={css.description}>{t('ssh.description')}</div>
        </div>
        <Switch
          checked={enabled}
          label={t('ssh.enabled')}
          onChange={setSshEnabled}
        />
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
    </div>
  )
}
