/** Floating desktop pet in the shell overlay. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductChromeInjected } from './product-chrome-types.ts'
import type { createProductChromeStore } from './product-chrome-store.ts'
import css from './DesktopPet.module.css'

/** Overlay props: chrome store plus locale. */
export type DesktopPetProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createProductChromeStore>>
  & PropsLocale<'settings'>
  & InjectFace<ProductChromeInjected>

/**
 * Render the desktop pet when enabled.
 * @param props - composed slot props.
 * @returns the overlay node, or null.
 */
export function DesktopPet({ useStore, t }: DesktopPetProps) {
  const enabled = useStore(s => s.desktopPet)
  if (!enabled) return null
  return (
    <div className={css.pet} role="img" aria-label={t('desktopPet.title')}>
      <FishLogo size={44} />
    </div>
  )
}
