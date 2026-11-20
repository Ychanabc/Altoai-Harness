/** Account settings renders safe Host state and explicit login actions. */
import { Big } from 'big.js'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Button, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountDetails, SiteAccountSession, SiteAccountBilling, SiteAccountSubscription, SiteAccountOutcome, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PlatformPage, PlatformPages } from './platform-pages.ts'
import { formatBalance } from './formatBalance.ts'
import { formatSiteQuota, formatQuotaPeriod } from './site-quota-format.ts'
import { AccountAvatar } from './AccountAvatar.tsx'
import type { AccountAvatarSnapshot } from './account-avatar.ts'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import css from './AccountSection.module.css'

/** Safe account snapshot shared by the settings page and launcher. */
export interface AccountSnapshot {
  /** Latest Host state, absent until the stream responds. */
  view: AccountView | undefined
  /** Sanitized profile and balance query outcomes, absent while loading. */
  details: Partial<AccountDetails> | undefined
  /** Independent website reads; undefined means loading. */
  siteSession?: SiteAccountOutcome<SiteAccountSession> | undefined
  siteBilling?: SiteAccountOutcome<SiteAccountBilling> | undefined
  /** Shared picture load; absent until a profile supplies a picture or after sign-out. */
  avatar: AccountAvatarSnapshot | undefined
  /** Whether the state stream failed. */
  failed: boolean
  /** Explicitly opened account dialog outside onboarding. */
  loginVisible?: boolean
  /** Latest explicit start request failed before a Host state was available. */
  loginFailed?: boolean
  /** Model credential onboarding owns the login dialog and delays account notifications while mounted. */
  onboarding?: boolean
  /** Desktop introduction covers the workspace during loading, saving, and exit animation.
   * True on Desktop until shell.overlay reports visibility, false in browsers; Desktop layouts must render that slot.
   */
  desktopOnboardingVisible?: boolean
}

/** Host operations injected into the Cordis-free account component. */
export interface AccountSectionInjected {
  /** @param snapshot - picture attempt whose rendered image failed; superseded attempts are ignored. */
  avatarFailed: (snapshot: AccountAvatarSnapshot) => void
  /** Subscribe to live credential-expiry notifications.
   * @param listener - callback after the current credential is removed.
   * @returns listener cleanup.
   */
  subscribeSessionExpired?: (listener: () => void) => () => void
  /** Subscribe to live model sign-in guidance; the returned function removes the listener.
   * @param listener - callback for one rejected account-model request.
   * @returns listener cleanup.
   */
  subscribeModelSignInRequired?: (listener: () => void) => () => void
  /** Desktop-only: show one page in the account feature's shared native host; absent in ordinary browsers. */
  openPlatformPage?: PlatformPages['open']

  /** Account stream owned by the Host and theme snapshots published by the renderer, observed through framework hooks. */
  hooks: {
    account: HostObservable<AccountSnapshot>
    /** Palette the Platform login pages follow. */
    theme: HostObservable<ThemeSnapshot>
  }
  /**
   * Retry a failed avatar, read the profile and balances, and notify account refresh extensions. The Settings launcher
   * calls it on each entry, and a page opener on return from top-up.
   * @returns after the account queries settle; image loading completes independently.
   */
  refreshAccount: () => Promise<void>
  /** Open the external support questionnaire with the account, build and environment sampled by this click. */
  contactUs: () => void
  /** Open or dismiss the login dialog. */
  showLogin: (visible: boolean) => void
  /** Claim dialog ownership for the onboarding step. */
  setOnboarding: (active: boolean) => void
  /** @returns after the login attempt is created. */
  start: () => Promise<void>
  /** @param id - attempt to cancel. @returns after cancellation or an already-admitted commit. */
  cancel: (id: SignInAttemptId) => Promise<void>
  /** @returns whether a running task currently uses the account token. */
  hasRunningAccountTasks: () => Promise<boolean>
  /** @returns after local account credentials are removed. */
  signOut: () => Promise<void>
}
/** Composed account section props. */
export type AccountSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected & {
    hooks: { formatLocale: HostObservable<string> }
  }>
function resetPeriodLabel(subscription: SiteAccountSubscription, t: AccountSectionProps['t'], locale: string): string | undefined {
  switch (subscription.resetPeriod) {
    case 'daily': return t('siteResetDaily')
    case 'weekly': return t('siteResetWeekly')
    case 'monthly': return t('siteResetMonthly')
    case 'never': return t('siteNoReset')
    case 'custom': return subscription.resetCustomSeconds ? formatQuotaPeriod(subscription.resetCustomSeconds, locale) : undefined
    default: return undefined
  }
}

/** @param props - localized actions, account subscription, and the shared Platform page channel. @returns account settings UI. */
export function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage,
  avatarFailed, refreshAccount, useFormatLocale }: AccountSectionProps) {
  const { view: state, details, siteSession, siteBilling, avatar, failed: streamFailed } = useAccount(value => value)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const locale = useFormatLocale(value => value)
  const quotaSettings = (siteBilling?.status === 'ready' ? siteBilling.value.quotaMetadata : undefined)
    ?? (siteSession?.status === 'ready' ? siteSession.value : undefined)
  const showQuota = (value: number) => formatSiteQuota(value, quotaSettings, locale)
    ?? `${new Intl.NumberFormat(locale).format(value)} ${t('siteQuotaUnits')}`
  const quotaUsage = (used: number, total: number) => `${showQuota(used)} / ${showQuota(total)} · ${t('siteRemain')} ${showQuota(Math.max(0, total - used))}`
  // The shared host owns the native view; this page holds only its own request,
  // and only while it is the latest owner.
  const releasePage = useRef<(() => void) | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const profile = details?.profile?.status === 'ready' ? details.profile.value : undefined
  const wallets = details?.balance?.status === 'ready' ? details.balance.value : undefined
  const bonusWallets = details?.balance?.status === 'ready'
    ? details.balance.bonusWallets.filter(wallet => new Big(wallet.balance).gt(0)) : []
  const showBonusRow = details?.balance?.status !== 'ready' || bonusWallets.length > 0
  const site = state?.brand !== undefined
  const attempt = state?.attempt
  const active = attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
  const signedIn = state?.status === 'credential-stored'
  useEffect(() => () => { releasePage.current?.(); releasePage.current = undefined }, [])
  useEffect(() => {
    if (signedIn) return
    releasePage.current?.()
    releasePage.current = undefined
  }, [signedIn])
  const showPage = (open: PlatformPages['open'], page: PlatformPage) => {
    releasePage.current?.()
    releasePage.current = open(page, () => { releasePage.current = undefined })
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  /**
   * @param event - click on a Platform destination link.
   * @returns nothing; on Desktop the embedded page replaces the pending navigation.
   */
  const openUsage = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!site && openPlatformPage !== undefined && signedIn) { event.preventDefault(); showPage(openPlatformPage, 'usage') }
  }
  /**
   * The Platform entry the balance rows share with the Usage action: an embedded page on
   * Desktop, a new tab elsewhere. A wallet read that failed still reaches the same
   * destination, so the user can inspect the balance the Harness could not load; the
   * destination comes from the account links, not from the wallet response.
   * @param label - localized link copy.
   * @param className - link treatment for the row that renders it, absent when the sheet has no such rule.
   * @returns the Platform anchor.
   */
  const platformLink = (label: string, className: string | undefined) => (
    <a className={className} href={state?.links.usageUrl} aria-disabled={state === undefined}
      target="_blank" rel="noreferrer" onClick={openUsage}>{label}</a>
  )
  const status = failed || streamFailed || attempt?.phase === 'failed' ? t('failed')
    : attempt?.phase === 'expired' ? t('expired')
      : active ? t(attempt.phase === 'initializing' ? 'initializing' : attempt.phase === 'waiting-browser' ? 'waiting' : 'completing')
        : signedIn ? profile?.contact ?? t(details?.profile === undefined ? 'loading' : 'profileUnavailable') : t('signInDescription')
  if (!signedIn && !active) return (
    <section className={css.signedOut} aria-label={t('nav')}>
      <div className={css.signedOutContent}>
        <div className={css.signedOutCopy}>
          <span className={css.signedOutTitle}>{t('settingsSignedOutTitle')}</span>
          <span className={css.signedOutDescription} role="status">
            {failed || streamFailed ? t('failed') : t('settingsSignedOutDescription')}
          </span>
        </div>
        <Button variant="primary" className={css.signInButton} disabled={busy || state === undefined}
          onClick={() => { void run(start) }}>{t('signIn')}</Button>
      </div>
    </section>
  )
  return (
    <section className={css.section} aria-label={t('nav')}>
      <div className={css.card}>
        <div className={css.identity}>
          <span className={css.avatar} data-avatar-status={signedIn ? avatar?.status : undefined}>
            <AccountAvatar avatar={signedIn ? avatar : undefined} avatarFailed={avatarFailed} />
          </span>
          <div className={css.identityCopy}>
            <span className={css.name}>{signedIn ? profile?.name ?? state.brand?.name ?? t('signedIn') : t('signedOut')}</span>
            <span className={css.status} role="status">{status}</span>
          </div>
        </div>
        {signedIn && <a className={css.accountInfo} href={new URL('/', state.links.usageUrl).href} target="_blank" rel="noopener noreferrer">
          {t('accountInfo')}<IconRightUpOutlineRegular size={12} />
        </a>}
      </div>
      {active && <div className={css.actions}>
        {attempt.authorizeUrl && <a className={css.linkButton} href={authorizeUrlWithTheme(attempt.authorizeUrl, colorScheme)}
          target="_blank" rel="noreferrer">
          {t('open')}
        </a>}
        <Button variant="outline" disabled={busy || attempt.phase === 'committing'}
          onClick={() => { void run(() => cancel(attempt.id)) }}>{t('cancel')}</Button>
      </div>}
      {site ? <>
        <div className={css.balanceCard}>
          <div className={css.row}><span>{t('siteProfile')}</span><Button variant="outline" disabled={busy}
            onClick={() => { void run(refreshAccount) }}>{t('platformRetry')}</Button></div>
          {siteSession === undefined ? <span role="status">{t('loading')}</span>
            : siteSession.status !== 'ready' ? <span role="alert">{t(siteSession.status === 'endpoint-unavailable' ? 'siteEndpointUnavailable' : 'siteReadFailed')}</span>
              : <>
                <div className={css.row}><span>{t('siteUsername')}</span><span>{siteSession.value.username}</span></div>
                <div className={css.row}><span>{t('siteUserGroup')}</span><span>{siteSession.value.group}</span></div>
                <div className={css.row}><span>{t('siteDeviceGroup')}</span><span>{siteSession.value.deviceGroup}</span></div>
                <div className={css.row}><span>{t('siteUsableGroups')}</span><span>{siteSession.value.usableGroups.join(', ')}</span></div>
              </>}
        </div>
        <div className={css.balanceCard}>
          <span>{t('siteWallet')}</span>
          {siteBilling === undefined ? <span role="status">{t('loading')}</span>
            : siteBilling.status !== 'ready' ? <span role="alert">{t(siteBilling.status === 'endpoint-unavailable' ? 'siteEndpointUnavailable' : 'siteReadFailed')}</span>
              : <>
                <div className={css.row}><span>{t('siteRemain')}</span><span>{showQuota(siteBilling.value.quota.remain)}</span></div>
                <div className={css.row}><span>{t('siteUsed')}</span><span>{showQuota(siteBilling.value.quota.used)}</span></div>
              </>}
        </div>
        <div className={css.balanceCard}>
          <span>{t('siteSubscriptions')}</span>
          {siteBilling === undefined ? <span role="status">{t('loading')}</span>
            : siteBilling.status !== 'ready' ? <span role="alert">{t(siteBilling.status === 'endpoint-unavailable' ? 'siteEndpointUnavailable' : 'siteReadFailed')}</span>
              : siteBilling.value.subscriptions.length === 0 ? <span>{t('siteNoSubscriptions')}</span>
                : siteBilling.value.subscriptions.map(sub => <article key={sub.id} className={css.subscription}>
                  <span className={css.name}>{sub.planAvailable ? sub.title : t('sitePlanUnavailable')}</span>
                  <div className={css.row}><span>{t('siteSubscriptionQuota')}</span><span>{sub.unlimited ? t('siteUnlimited') : quotaUsage(sub.used, sub.total)}</span></div>
                  {sub.planAvailable && <div className={css.row}><span>{t('siteHourQuota')}</span><span>{sub.hourUnlimited ? t('siteUnlimited') : quotaUsage(sub.hourUsed, sub.hourQuota)}
                    {sub.hourWindowSeconds > 0 && ` · ${formatQuotaPeriod(sub.hourWindowSeconds, locale)}`}</span></div>}
                  {sub.planAvailable && sub.resetPeriod !== '' && <div className={css.row}><span>{t('siteResetPeriod')}</span><span>{
                    resetPeriodLabel(sub, t, locale) ?? t('siteResetUnavailable')
                  }</span></div>}
                  <div className={css.row}><span>{t('siteNextReset')}</span><span>{sub.nextResetTime > 0 ? new Date(sub.nextResetTime * 1000).toLocaleString(locale) : t('siteNoReset')}</span></div>
                  <div className={css.row}><span>{t('siteExpiry')}</span><span>{sub.endTime > 0 ? new Date(sub.endTime * 1000).toLocaleString(locale) : t('siteNoExpiry')}</span></div>
                </article>)}
          <div className={css.links}><a className={css.linkButton} href={state.links.usageUrl} target="_blank" rel="noreferrer">{t('usage')}</a>
            <a className={css.linkButton} href={state.links.topUpUrl} target="_blank" rel="noreferrer">{t('siteManageWallet')}</a></div>
        </div>
      </> : <div className={css.balanceCard}>
        <div className={css.row}>
          <span>{t('balance')}</span>
          {signedIn && wallets !== undefined && wallets.length > 0
            ? <span className={css.amount}>{wallets.map(wallet => <span key={wallet.currency}>
              {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
            </span>)}</span>
            : !signedIn || details?.balance === undefined
              ? <span className={css.unavailable}>{t(!signedIn ? 'balanceSignedOut' : 'loading')}</span>
              : platformLink(t('balanceUnavailable'), css.unavailableLink)}
        </div>
        {signedIn && showBonusRow && <>
          <div className={css.divider} />
          <div className={css.row}>
            <span>{t('bonusBalance')}</span>
            <span className={css.bonusValue}>
              {bonusWallets.length > 0
                ? <span className={css.amount}>{bonusWallets.map(wallet => <span key={wallet.currency}>
                  {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
                </span>)}</span>
                : details?.balance === undefined
                  ? <span className={css.unavailable}>{t('loading')}</span>
                  : platformLink(t('balanceUnavailable'), css.unavailableLink)}
            </span>
          </div>
        </>}
        <div className={css.divider} />
        <div className={css.row}>
          <span className={css.secondary}>{t('more')}</span>
          <div className={css.links}>
            {platformLink(t('usage'), css.linkButton)}
            <a className={`${css.linkButton} ${css.primary}`} href={state?.links.topUpUrl} aria-disabled={state === undefined}
              target="_blank" rel="noreferrer"
              onClick={(event) => { if (openPlatformPage !== undefined && signedIn) { event.preventDefault(); showPage(openPlatformPage, 'top-up') } }}>{t('topUp')}</a>
          </div>
        </div>
      </div>}
    </section>
  )
}
