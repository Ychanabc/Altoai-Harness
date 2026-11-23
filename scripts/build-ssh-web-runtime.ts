/** Build a relocatable Linux dsh web runtime for desktop SSH workspaces. */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { create as createTar } from 'tar'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'
import { pnpmInvocation, verifyStagedDependencies } from './executable-packaging.ts'
import { resolveLinuxNodePtyAddon } from './executable-native-pty.ts'
import { downloadNodeRuntime } from './primary-runtime/prepare.ts'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { output: { type: 'string' } } })
const output = resolve(root, values.output ?? 'dist-exe/ssh-web')
const arch = process.arch
if (process.platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) {
  throw new Error('SSH Web runtime requires a native Linux x64 or arm64 build host.')
}
const target = 'linux-' + arch

async function smokeRuntime(node: string, entry: string, project: string, home: string): Promise<void> {
  const ready = Promise.withResolvers<URL>()
  const host = spawn(node, [entry, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open', '--ssh-workspace', project], {
    cwd: project,
    env: {
      ...process.env,
      PATH: dirname(node) + delimiter + (process.env.PATH ?? ''),
      ALTOAIH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolve) => { host.once('close', () => resolve()) })
  const timeout = setTimeout(() => ready.reject(new Error('The staged SSH Web Host did not become ready.')), 30_000)
  host.once('error', ready.reject)
  host.once('close', (code, signal) => ready.reject(new Error('The staged SSH Web Host exited with ' + String(code ?? signal))))
  let diagnostic = ''
  host.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-12_000)
  })
  const lines = createInterface({ input: host.stdout })
  lines.on('line', (line) => {
    const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)$/u.exec(line)
    if (match?.[1] !== undefined) ready.resolve(new URL(match[1]))
  })
  try {
    const url = await ready.promise
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    if (response.status < 200 || response.status >= 400) {
      throw new Error('The staged SSH Web Host rejected its launch URL with HTTP ' + response.status)
    }
  } catch (error) {
    const message = diagnostic.trim().replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]')
    if (message !== '') process.stderr.write(message + '\n')
    throw error
  } finally {
    clearTimeout(timeout)
    lines.close()
    host.kill('SIGTERM')
    const kill = setTimeout(() => { host.kill('SIGKILL') }, 5_000)
    await closed
    clearTimeout(kill)
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'altoaih-ssh-web-'))
try {
  const app = join(temporary, 'app')
  const node = join(temporary, 'node')
  const [command, args] = pnpmInvocation([
    '--filter', '@deepseek-ai/dsh', 'deploy', '--prod',
    '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted',
    '--config.link-workspace-packages=true',
    '--config.hoist-workspace-packages=false',
    '--config.pnpmfile=' + join(root, 'scripts/python-runtime-deploy.pnpmfile.mjs'), app,
  ])
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
  await materializeStagedLinks(app)
  await deduplicateStagedWorkspacePackages(app, app)
  await verifyStagedDependencies(app)

  const pty = resolveLinuxNodePtyAddon(join(root, 'packages/subprocess/subprocess-local/node_modules/node-pty'), arch)
  const ptyPath = join(app, 'node_modules/node-pty/build/Release')
  await mkdir(ptyPath, { recursive: true })
  await copyFile(pty, join(ptyPath, 'pty.node'))

  await downloadNodeRuntime(target === 'linux-x64' ? 'linux-x64' : 'linux-arm64', node, join(root, '.dsh-build/downloads'))
  const executable = join(node, 'bin/node')
  await chmod(executable, 0o755)
  const project = join(temporary, 'project')
  await mkdir(project)
  await smokeRuntime(executable, join(app, 'lib/bin.js'), project, join(temporary, 'smoke-home'))

  await mkdir(output, { recursive: true })
  const filename = 'altoaih-ssh-' + target + '.tar.gz'
  const staging = await mkdtemp(join(output, '.incoming-'))
  try {
    const archive = join(staging, filename)
    await createTar({ cwd: temporary, file: archive, gzip: true, portable: true }, ['node', 'app'])
    const hash = createHash('sha256')
    for await (const block of createReadStream(archive)) hash.update(block)
    await writeFile(archive + '.sha256', hash.digest('hex') + '\n')
    await rename(archive, join(output, filename))
    await rename(archive + '.sha256', join(output, filename + '.sha256'))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
