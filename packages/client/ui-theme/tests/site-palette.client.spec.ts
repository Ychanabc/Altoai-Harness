/** Site semantics keep readable actions and the same pre-plugin and Desktop canvas. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bootThemeInjections } from '../src/boot-theme.ts'
import { parseRules } from './stylesheet-scan.ts'

const css = readFileSync(new URL('../src/styles/site-palette.css', import.meta.url), 'utf8')
const rules = parseRules(css)
const definitions = new Map(rules.flatMap(rule => rule.declarations))
const desktop = readFileSync(new URL('../../../../apps/desktop/renderer/welcome.css', import.meta.url), 'utf8')

function color(name: string, dark: boolean): string {
  const value = definitions.get(name)
  if (value === undefined) throw new Error(`Missing site token ${name}`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias?.[1] !== undefined) return color(alias[1], dark)
  const pair = /^light-dark\((#[\da-f]+), (#[\da-f]+)\)$/.exec(value)
  return pair === null ? value : pair[dark ? 2 : 1]!
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

describe('site palette', () => {
  it.each([false, true])('keeps primary actions readable at rest and hover, dark=%s', (dark) => {
    const foreground = color('--dsw-alias-label-primary-foreground', dark)
    expect(foreground).toBe('#ffffff')
    for (const role of ['button-primary-fill', 'button-primary-hover']) {
      expect(contrast(foreground, color(`--dsw-alias-${role}`, dark))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each([false, true])('keeps body and supporting text readable, dark=%s', (dark) => {
    for (const role of ['label-primary', 'label-secondary', 'label-tertiary', 'label-caption', 'link']) {
      expect(contrast(color(`--dsw-alias-${role}`, dark), color('--dsw-alias-bg-base', dark))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(['light', 'dark'] as const)('matches the %s first-paint canvas to the client palette', (mode) => {
    const [head] = bootThemeInjections(mode)
    expect(head?.kind).toBe('style')
    if (head?.kind !== 'style') throw new Error('Missing head style')
    expect(head.text).toContain(`background-color:${color('--dsw-alias-bg-base', mode === 'dark')}`)
  })

  it('retains upstream static, inverted-ink and platform-material ownership', () => {
    expect([...definitions.keys()].filter(name => name.startsWith('--dsw-static-'))).toEqual([])
    expect(definitions.has('--dsw-alias-label-primary-inverted')).toBe(false)
    expect(definitions.has('--dsw-menu-surface-fill')).toBe(false)
    expect(definitions.has('--dsw-menu-backdrop-filter')).toBe(false)
    expect(rules.find(rule => rule.selectors.includes('body'))?.declarations).toContainEqual(['color-scheme', 'light'])
    expect(rules.find(rule => rule.selectors.includes('body[data-ds-dark-theme]'))?.declarations).toContainEqual(['color-scheme', 'dark'])
  })

  it('shares the emitted palette with Desktop and preserves logo aspect ratio and disabled actions', () => {
    expect(desktop).toContain("@import url('../lib/welcome/site-palette.css')")
    const desktopRules = parseRules(desktop)
    expect(desktopRules.find(rule => rule.selectors.includes('.brand'))?.declarations).toContainEqual(['object-fit', 'contain'])
    expect(desktopRules.find(rule => rule.selectors.includes('.primary'))?.declarations)
      .toContainEqual(['color', 'var(--dsw-alias-label-primary-foreground)'])
    expect(desktopRules.find(rule => rule.selectors.includes('.actions button:disabled'))?.declarations)
      .toContainEqual(['cursor', 'not-allowed'])
    expect(desktopRules.find(rule => rule.selectors.includes('.actions button:focus-visible'))?.declarations)
      .toContainEqual(['outline', '2px solid var(--dsw-alias-state-business-primary)'])
    expect(desktopRules.find(rule => rule.selectors.includes('.primary:hover:not(:disabled)'))?.declarations)
      .toContainEqual(['background', 'var(--dsw-alias-button-primary-hover)'])
    const config = readFileSync(new URL('../../../../apps/desktop/tsdown.config.ts', import.meta.url), 'utf8')
    expect(config).toContain("'site-palette.css'")
  })
})
