/** Website branding projected from the existing account stream. */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import css from './SiteBrand.module.css'

type BrandProps = InjectFace<Pick<AccountSectionInjected, 'hooks'>>

/** @returns the fixed product name provided by the site Desktop document, if present. */
export function desktopProductName(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="dsh-product-title"]')?.content
}

/** @param props - live account projection. @returns the Desktop product name or standalone website name. */
export function SiteBrandName({ useAccount }: BrandProps) {
  const websiteName = useAccount(state => state.view?.brand?.name)
  const name = desktopProductName() ?? websiteName
  return <span className={css.name} title={name}>{name}</span>
}

/** @param props - live account projection and requested mark size. @returns a contained logo or site initial. */
export function SiteBrandMark({ useAccount, size }: BrandProps & { size: number }) {
  const brand = useAccount(state => state.view?.brand)
  const [failedUrl, setFailedUrl] = useState<string>()
  const desktop = desktopProductName() !== undefined
  return <span className={css.mark} style={{ width: size, height: size }} aria-hidden="true">
    {desktop ? <img src="/assets/altoai-mark.png" alt="" /> : brand?.logo && failedUrl !== brand.logo
      ? <img src={brand.logo} alt="" onError={() => { setFailedUrl(brand.logo) }} />
      : <span>{brand?.name.slice(0, 1)}</span>}
  </span>
}

/** @param props - account brand and shell session selection. @returns no visible content. */
export function SiteDocumentTitle({ useAccount, usePanelInfo, useSessions }: BrandProps & PropsRuntime<'shell.document-title'>) {
  const websiteName = useAccount(state => state.view?.brand?.name)
  const brand = desktopProductName() ?? websiteName
  const showSession = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions(state => Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.title)
  useEffect(() => {
    if (brand === undefined) return
    document.title = showSession && title !== undefined ? `${title} — ${brand}` : brand
  }, [brand, title, showSession])
  return null
}

/** @param props - the wrapped home content. @returns website home without upstream decorative artwork. */
export function SiteBrandFrame({ children }: { children: ReactNode }) {
  return <>{children}</>
}
