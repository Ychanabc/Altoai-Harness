/** Display formatting for website wallet and subscription quota. */
import type { SiteQuotaMetadata } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * Format an unconverted quota integer using the website wallet's display rules.
 * @param quota - raw quota used for billing.
 * @param settings - display settings from the site, if available.
 * @param locale - active UI locale.
 * @returns display text, or undefined when an older site lacks the required settings.
 */
export function formatSiteQuota(quota: number, settings: Partial<SiteQuotaMetadata> | undefined, locale: string): string | undefined {
  if (settings === undefined) return undefined
  if (settings.quotaDisplayType === 'TOKENS') {
    // Match the website's one-decimal k abbreviation without converting to USD and back.
    return Math.abs(quota) >= 1000 ? `${(quota / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(quota)
  }
  const mode = settings.quotaDisplayType
  const perUnit = settings.quotaPerUnit
  if (perUnit === undefined || mode === undefined) return undefined
  let rate: number | undefined
  switch (mode) {
    case 'USD': rate = 1; break
    case 'CNY': rate = settings.usdExchangeRate; break
    case 'CUSTOM': rate = settings.customCurrencyExchangeRate; break
    default: return undefined
  }
  if (rate === undefined) return undefined
  const value = quota / perUnit * (rate > 0 ? rate : 1)
  if (!Number.isFinite(value)) return undefined
  const digits = Math.abs(value) >= 1 ? 2 : 4
  const minimum = 10 ** -digits
  const displayValue = value === 0 ? 0 : Math.sign(value) * Math.max(Math.abs(value), minimum)
  const formatter = mode === 'CUSTOM'
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: digits })
    : new Intl.NumberFormat(locale, { style: 'currency', currency: mode, currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0, maximumFractionDigits: digits })
  const formatted = formatter.format(displayValue)
  return mode === 'CUSTOM' ? `${settings.customCurrencySymbol?.trim() || '¤'} ${formatted}` : formatted
}

/**
 * Format a quota window without dropping partial hours, days, or minutes.
 * @param seconds - positive window length from the site.
 * @param locale - active UI locale.
 * @returns localized duration in the largest exact unit.
 */
export function formatQuotaPeriod(seconds: number, locale: string): string {
  const [divisor, unit] = ([[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']] as const)
    .find(([size]) => seconds % size === 0) ?? [1, 'second']
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / divisor)
}
