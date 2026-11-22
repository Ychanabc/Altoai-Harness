/**
 * One-click light/dark control at the sidebar foot. Selection follows the
 * resolved palette so a `system` preference still flips to an explicit mode.
 */
import clsx from 'clsx'
import { IconDarkOutlineMedium, IconLightOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppearanceRowInjected } from './AppearanceRow.tsx'
import type { createAppearanceRowStore } from './settings-store.ts'
import css from './ThemeToggle.module.css'

/** Full component props: sidebar foot owner share + appearance store + locale. */
export type ThemeToggleProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createAppearanceRowStore>>
  & PropsLocale<'settings.theme'>
  & AppearanceRowInjected

/**
 * Render the sidebar theme toggle.
 * @param props - composed slot props.
 * @returns the foot control.
 */
export function ThemeToggle({ t, setTheme, useStore, wide }: ThemeToggleProps) {
  const colorScheme = useStore(s => s.colorScheme)
  const toDark = colorScheme !== 'dark'
  const label = t(toDark ? 'toggle.toDark' : 'toggle.toLight')
  const Icon = toDark ? IconDarkOutlineMedium : IconLightOutlineMedium
  return (
    <div className={clsx(css.row, !wide && css.railRow)}>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-label={label}
        onClick={() => { setTheme(toDark ? 'dark' : 'light') }}
      >
        <Icon />
        {wide ? <span className={css.label}>{label}</span> : null}
      </button>
    </div>
  )
}
