/** Searchable catalog from the same public source as the Altoai website. */
import { useEffect, useMemo, useState } from 'react'
import {
  Button, IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconDeliverDocRegular,
  IconRefreshOutlineRegular, IconSearchOutlineRegular, IconSkillOutlineRegular, IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { TextSearchIndex } from '@deepseek-ai/dsh-util-text-search'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillLibrary.module.css'

const upstream = 'https://github.com/anthropics/skills/blob/main/skills'
const catalogUrl = 'https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1'
const refreshIntervalMs = 10 * 60 * 1000

function iconForSkill(name: string) {
  if (/^(?:docx|pdf|pptx|xlsx)$/u.test(name)) return IconDeliverDocRegular
  if (/(?:mcp|testing|artifact|developer)/u.test(name)) return IconCodeOutlineRegular
  if (/(?:design|art|gif|theme)/u.test(name)) return IconSparkleRegular
  return IconSkillOutlineRegular
}

/** @param props - Navigation icon size supplied by the sidebar. */
export function SkillLibraryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconSkillOutlineRegular size={size} />
}

/** @param props - Localized skill catalog controls and messages. */
export function SkillLibrary({ t }: PropsLocale<'skill'>) {
  const [skills, setSkills] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const index = useMemo(() => new TextSearchIndex(skills, name => ({ fuzzy: [name] })), [skills])
  const visible = useMemo(() => index.search(query), [index, query])

  useEffect(() => {
    const timer = window.setInterval(() => { setRefresh(value => value + 1) }, refreshIntervalMs)
    return () => { window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
    const sync = async (): Promise<void> => {
      setStatus('loading')
      try {
        const response = await fetch(catalogUrl, { signal, cache: 'no-cache', credentials: 'omit' })
        if (!response.ok) throw new Error('GitHub catalog request failed')
        const result: unknown = await response.json()
        if (typeof result !== 'object' || result === null || !('tree' in result) || !Array.isArray(result.tree)
          || ('truncated' in result && result.truncated === true)) throw new Error('Invalid GitHub catalog')
        const names = result.tree.flatMap((entry: unknown) => {
          if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string'
            || !('type' in entry) || entry.type !== 'blob') return []
          const name = /^skills\/([a-z][a-z0-9-]*)\/SKILL\.md$/u.exec(entry.path)?.[1]
          return name === undefined ? [] : [name]
        })
        if (controller.signal.aborted) return
        setSkills(names.sort())
        setStatus('ready')
      } catch {
        if (!controller.signal.aborted) setStatus('failed')
      }
    }
    void sync()
    return () => { controller.abort() }
  }, [refresh])

  return (
    <section className={css.page} aria-labelledby="skill-library-title">
      <div className={css.content}>
        <header className={css.header}>
          <h1 id="skill-library-title">{t('library.title')}</h1>
          <Button variant="outline" disabled={status === 'loading'} onClick={() => { setRefresh(value => value + 1) }}>
            <IconRefreshOutlineRegular size={16} />
            {t('library.refresh')}
          </Button>
        </header>
        <div className={css.search}>
          <IconSearchOutlineRegular size={16} />
          <input type="search" value={query} aria-label={t('library.search')}
            placeholder={t('library.search')} onChange={(event) => { setQuery(event.target.value) }} />
        </div>
        {status === 'loading' && <p className={css.notice} role="status">{t('library.loading')}</p>}
        {status === 'failed' && <p className={css.notice} role="alert">{t('library.failed')}</p>}
        {status === 'ready' && visible.length === 0 && <p className={css.notice} role="status">{t('library.empty')}</p>}
        <ul className={css.grid}>
          {visible.map((name) => {
            const Icon = iconForSkill(name)
            return (
              <li key={name}>
                <a href={`${upstream}/${encodeURIComponent(name)}/SKILL.md`} target="_blank" rel="noreferrer">
                  <span className={css.cardIcon}><Icon size={20} /></span>
                  <span className={css.cardTitle}>{name}</span>
                  <IconChevronRightOutlineRegular className={css.cardArrow} size={16} />
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
