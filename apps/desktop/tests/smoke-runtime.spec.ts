/** Packaged runtime HTTP authentication and Office skill probe results. */

import type { ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertOfficeSkillsLoadable, smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { DesktopParentAuthentication } from '../src/parent-authentication.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const boundary = vi.hoisted(() => ({
  start: vi.fn<() => Promise<{ url: string; injections: []; authenticationCookie: string }>>(),
  stop: vi.fn(async () => {}),
  run: vi.fn<(_executable: string, _args: string[], _options: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>>(),
}))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    start = boundary.start
    stop = boundary.stop
  },
}))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: boundary.run }) }
})
afterEach(() => {
  boundary.start.mockReset()
  boundary.stop.mockClear()
  boundary.run.mockReset()
  vi.restoreAllMocks()
})

const loadedSkills = [
  { name: 'office', bytes: 772 },
  { name: 'office-docx', bytes: 4543 },
  { name: 'office-pptx', bytes: 5167 },
  { name: 'office-xlsx', bytes: 5611 },
]

it('uses the private readiness Cookie for every packaged runtime HTTP probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-auth-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-smoke-auth-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  })
  const runtime = runtimeFixture(join(root, 'payload'))
  const resources = join(root, 'runtime')
  const primary = join(resources, 'primary-runtime')
  mkdirSync(primary, { recursive: true })
  writeFileSync(join(primary, 'runtime.json'), JSON.stringify({
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    python: '3.12.0', pythonPackages: {},
  }))
  const authentication = new DesktopParentAuthentication()
  let secret = ''
  const send: ChildProcess['send'] = (message: unknown, ...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof message !== 'object' || message === null || !('secret' in message)
      || typeof message.secret !== 'string' || typeof callback !== 'function') {
      throw new Error('invalid Desktop authentication handoff')
    }
    secret = message.secret
    callback(null)
    return true
  }
  await authentication.deliver({ send })
  const cookie = await authentication.readyCookie()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(Connection).await()
  await ctx.plugin(DesktopAuthentication, { readSecret: () => secret }).await()
  const requests: { path: string | undefined; cookie: string | undefined }[] = []
  ctx.on('webserver/request', async (request, _response, next) => {
    requests.push({ path: request.url, cookie: request.headers.cookie })
    await next()
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/session/create',
    handler(_request, response) {
      response.end(JSON.stringify({ result: { ok: true, value: { sessionId: 'ssh-fixture-session' } } }))
    },
  }))
  ctx.effect(() => ctx.webServer.registerFallback({
    handler(request, response) {
      const path = request.url
      if (path === '/') response.end('<html>packaged fixture</html>')
      else if (path === '/desktop-smoke-ssh-session') response.end(JSON.stringify({
        id: 'ssh-fixture-session', cwd: 'ssh://project@192.0.2.7:22/srv/project',
      }))
      else if (path === '/desktop-smoke') response.end('plugin route ready')
      else if (path === '/desktop-smoke-install') response.end('{}')
      else if (path === '/desktop-smoke-installed') response.end('installed plugin ready')
      else if (path === '/desktop-smoke-skills') response.end(JSON.stringify(loadedSkills))
      else if (path?.startsWith('/desktop-smoke-office/')) response.end('%PDF-1.7\nfixture\n%%EOF')
      else if (path?.startsWith('/desktop-smoke-office-operations/')) response.end(JSON.stringify({
        images: ['89504e470d0a1a0a'], converted: '504b0304', recalculated: path.endsWith('/xlsx') ? '504b0304' : null,
      }))
      else response.writeHead(404).end()
    },
  }))
  boundary.start.mockResolvedValue({ url: ctx.webServer.getOrigin(), injections: [], authenticationCookie: cookie })
  let smokeHome: string | undefined
  // HTTP admission uses the credential issued by the shell and delivered over the fixture IPC channel.
  boundary.run.mockImplementation(async (_executable, args, options) => {
    if (options.cwd === undefined) {
      const home = args.at(-1)!
      for (const extension of ['docx', 'xlsx', 'pptx']) writeFileSync(join(home, `input.${extension}`), 'fixture')
    } else {
      const home = options.cwd
      smokeHome = home
      const installed = join(home, 'profiles', 'desktop', 'node_modules', 'desktop-installed-smoke-plugin')
      if (args.includes('add')) cpSync(join(home, 'desktop-installed-smoke-plugin'), installed, { recursive: true })
      else {
        if (!args.includes('remove') || !isAbsolute(home) || dirname(home) !== resolve(tmpdir())
          || !basename(home).startsWith('dsh-desktop-smoke-')) throw new Error('unexpected package-manager fixture operation')
        expect(readFileSync(join(installed, 'index.js'), 'utf8')).toContain('installed plugin ready')
        rmSync(installed, { recursive: true })
      }
    }
    return { stdout: '', stderr: '' }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await smokeDesktopRuntime(join(root, 'payload'), process.execPath, runtime, {}, resources)
  expect(requests.map(request => request.path)).toEqual([
    '/', '/api/session/create', '/desktop-smoke-ssh-session', '/desktop-smoke', '/desktop-smoke-install',
    '/desktop-smoke-installed', '/desktop-smoke-skills',
    '/desktop-smoke-office/docx', '/desktop-smoke-office/xlsx', '/desktop-smoke-office/pptx',
    '/desktop-smoke-office-operations/docx', '/desktop-smoke-office-operations/xlsx', '/desktop-smoke-office-operations/pptx',
  ])
  expect(requests.every(request => request.cookie === cookie)).toBe(true)
  expect(boundary.stop).toHaveBeenCalledOnce()
  expect(smokeHome).toBeDefined()
  expect(existsSync(smokeHome!)).toBe(false)
})

describe('assertOfficeSkillsLoadable', () => {
  it('accepts all four Office skills with nonempty bodies and no path', () => {
    expect(() => { assertOfficeSkillsLoadable(loadedSkills) }).not.toThrow()
  })

  it('rejects an unlisted or empty Office skill and reports every result', () => {
    const results = loadedSkills.map(skill => skill.name === 'office-docx' ? { ...skill, bytes: 0 } : skill)
    expect(() => { assertOfficeSkillsLoadable(results) }).toThrow(
      `desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`,
    )
  })

  it('rejects results missing a bundled Office skill', () => {
    const results = loadedSkills.filter(skill => skill.name !== 'office-xlsx')
    expect(() => { assertOfficeSkillsLoadable(results) }).toThrow(
      `desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`,
    )
  })

  it('ignores empty results for skills outside the bundled Office set', () => {
    expect(() => { assertOfficeSkillsLoadable([...loadedSkills, { name: 'other', bytes: 0 }]) }).not.toThrow()
  })
})
