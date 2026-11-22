/** General Settings control for the desktop pet overlay. */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductChromeInjected } from './product-chrome-types.ts'
import type { createProductChromeStore } from './product-chrome-store.ts'
import css from './DeveloperToolsRow.module.css'

/** Row props: chrome store plus locale. */
export type DesktopPetRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsStore<ReturnType<typeof createProductChromeStore>>
  & PropsLocale<'settings'>
  & InjectFace<ProductChromeInjected>

/**
 * Render the desktop pet toggle.
 * @param props - accepted preference, writer and localized copy.
 * @returns the General Settings row.
 */
export function DesktopPetRow({ useStore, setDesktopPet, t }: DesktopPetRowProps) {
  const enabled = useStore(s => s.desktopPet)
  return (
    <div className={css.row}>
      <div>
        <div className={css.title}>{t('desktopPet.title')}</div>
        <div className={css.description}>{t('desktopPet.description')}</div>
      </div>
      <Switch
        checked={enabled}
        label={t('desktopPet.title')}
        onChange={setDesktopPet}
      />
    </div>
  )
}
