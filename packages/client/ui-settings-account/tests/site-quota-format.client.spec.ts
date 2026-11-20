/** Website quota display uses raw amounts and exactly one configured conversion. */
import { expect, it } from 'vitest'
import { formatSiteQuota, formatQuotaPeriod } from '../src/client/site-quota-format.ts'

const config = { quotaPerUnit: 400000, usdExchangeRate: 7.15, customCurrencyExchangeRate: 2.5, customCurrencySymbol: ' Cr ' }
it.each([
  ['USD', 500000, '$1.25'],
  ['USD', 12500, '$0.0313'],
  ['USD', -1, '-$0.0001'],
  ['USD', 0, '$0'],
  ['CNY', 500000, '¥8.94'],
  ['CNY', 500000000, '¥8,937.5'],
  ['CUSTOM', 500000, 'Cr 3.13'],
  ['CUSTOM', 25000, 'Cr 0.1563'],
  ['TOKENS', 1950, '1.9k'],
  ['TOKENS', 999, '999'],
])('formats %s raw quota %s as %s', (quotaDisplayType, quota, expected) => {
  expect(formatSiteQuota(quota, { ...config, quotaDisplayType }, 'en-US')).toBe(expected)
})

it('uses the active locale and does not guess an absent exchange rate', () => {
  expect(formatSiteQuota(500000, { ...config, quotaDisplayType: 'CUSTOM' }, 'de-DE')).toBe('Cr 3,13')
  expect(formatSiteQuota(500000, { quotaPerUnit: 400000, quotaDisplayType: 'CNY' }, 'en-US')).toBeUndefined()
  expect(formatSiteQuota(500000, undefined, 'en-US')).toBeUndefined()
})

it.each([[18000, '5 hours'], [5400, '90 minutes'], [7 * 86400, '7 days'], [61, '61 seconds']])(
  'formats a %s-second period without truncation', (seconds, expected) => {
    expect(formatQuotaPeriod(seconds, 'en-US')).toBe(expected)
  },
)
