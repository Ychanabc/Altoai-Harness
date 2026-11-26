/** Root-scoped controller for the right Sidebar's Session content. */
import { memo, useLayoutEffect } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import type {} from '../contract/slots.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: { readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]> }
  readonly mountView: (reference: SessionReference) => () => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'> & InjectFace<RightbarRootInjected>

type SessionViewProps =
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly active: boolean }

function SessionView({ view, active, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }: SessionViewProps) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSlot('rightbar.session', { width, viewportWidth, canShow, active, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

// Retained background sessions deliberately stay mounted so their tabs survive
// a conversation switch. They do not need to re-render for every animated
// frame width update, though; only the foreground can observe that geometry.
const RetainedSessionView = memo(SessionView, (previous, next) => {
  if (previous.view.sessionId !== next.view.sessionId
    || previous.view.reference !== next.view.reference
    || previous.active !== next.active) return false
  if (!next.active) return true
  return previous.view.retainTab === next.view.retainTab
    && previous.SessionProvider === next.SessionProvider
    && previous.renderSlot === next.renderSlot
    && previous.mountView === next.mountView
    && previous.width === next.width
    && previous.viewportWidth === next.viewportWidth
    && previous.canShow === next.canShow
})

/**
 * Keep independent Session subtrees and hide those outside the selected Conversation.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars.
 */
export function RightbarRoot({ usePanelInfo, useViews, ...props }: RootProps) {
  const visible = usePanelInfo(info => info.activePanelId === null)
  const views = useViews(value => value)
  return <>{views.map(view => <RetainedSessionView key={view.sessionId} {...props} view={view} active={visible && view.selected} />)}</>
}
