/** Installs desktop-supplied Linux Web Host archives inside the SSH account. */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { PasswordTransport } from './ssh-transport.ts'

type SshFailureCode = 'SSH_WORKSPACE_DIRECTORY_UNAVAILABLE' | 'SSH_WORKSPACE_RUNTIME_UNAVAILABLE'
  | 'SSH_WORKSPACE_INSTALL_FAILED' | 'SSH_WORKSPACE_START_FAILED' | 'SSH_WORKSPACE_FORWARD_UNAVAILABLE'

/** Connect or deploy failure with a stage that the caller can report. */
export class SshWorkspaceError extends HarnessError {
  override readonly name = 'SshWorkspaceError'

  /**
   * @param code - Connection stage that failed.
   * @param message - Actionable error without remote output or credentials.
   * @param options - Underlying failure, if available.
   */
  constructor(code: SshFailureCode, message: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

/**
 * Quote a literal argument for an SSH account's POSIX shell.
 * @param value - Argument without NUL bytes.
 * @returns One shell argument.
 */
export function quoteSsh(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

const runtimeRoot = '"$HOME/.altoaih-remote-ssh/runtimes"'

/**
 * Resolve the SSH project-specific home as a literal POSIX shell expression.
 * @param project - Absolute project directory on the server.
 * @returns A quoted expression using the remote login's home.
 */
export function sshProjectHome(project: string): string {
  return '"$HOME/.altoaih-remote-ssh/' + createHash('sha256').update(project).digest('hex') + '"'
}

async function run(transport: PasswordTransport, command: string, signal: AbortSignal, archive?: string) {
  const channel = await transport.exec('sh -c ' + quoteSsh(command), signal)
  const result = Promise.withResolvers<{ status: number | undefined; stdout: string }>()
  let stdout = ''
  channel.on('error', result.reject)
  channel.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    if (stdout.length > 4096) {
      result.reject(new Error('SSH preflight or installation emitted too much output'))
      channel.destroy()
    }
  })
  channel.stderr.resume()
  channel.once('close', (code?: number | null) => result.resolve({ status: code ?? undefined, stdout }))
  const abort = (): void => { result.reject(signal.reason); channel.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    if (archive === undefined) {
      channel.end()
      return await result.promise
    }
    // An SSH exec channel remains readable after the upload sends EOF.
    const [output] = await Promise.all([result.promise, pipeline(createReadStream(archive), channel, { signal })])
    return output
  } finally {
    signal.removeEventListener('abort', abort)
    channel.destroy()
  }
}

/**
 * Select and install the matching Linux archive before launching the Web Host.
 * @param transport - Authenticated, host-key-pinned connection.
 * @param project - Absolute project directory on the server.
 * @param directory - Archive directory on the desktop. When absent, use the existing remote dsh installation.
 * @param signal - Connection or deployment deadline.
 * @param modelRelay - require desktop model relay capability in a server-installed runtime.
 * @returns Shell command prefix for the selected remote CLI.
 */
export async function prepareSshRuntime(
  transport: PasswordTransport,
  project: string,
  directory: string | undefined,
  signal: AbortSignal,
  modelRelay = false,
): Promise<string> {
  const probe = await run(transport, [
    'cd -- ' + quoteSsh(project) + ' || exit 41',
    'printf "ALTOAIH_REMOTE_PLATFORM=%s/%s\\n" "$(uname -s)" "$(uname -m)"',
  ].join('\n'), signal)
  if (probe.status === 41) {
    throw new SshWorkspaceError('SSH_WORKSPACE_DIRECTORY_UNAVAILABLE', 'SSH login succeeded, but the project directory is missing or not accessible.')
  }
  if (probe.status !== 0) {
    throw new SshWorkspaceError('SSH_WORKSPACE_RUNTIME_UNAVAILABLE', 'SSH login succeeded, but the account could not start a remote shell to check the project.')
  }
  const platform = /^ALTOAIH_REMOTE_PLATFORM=([A-Za-z0-9_/-]+)$/mu.exec(probe.stdout)?.[1]
  const architecture = platform === 'Linux/x86_64' ? 'x64' : platform === 'Linux/aarch64' ? 'arm64' : undefined
  if (architecture !== undefined && directory !== undefined) {
    const archive = join(directory, 'altoaih-ssh-linux-' + architecture + '.tar.gz')
    let checksum: string | undefined
    try {
      checksum = (await readFile(archive + '.sha256', { encoding: 'utf8', signal })).trim()
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new SshWorkspaceError('SSH_WORKSPACE_RUNTIME_UNAVAILABLE', 'The desktop could not read its SSH runtime checksum.', { cause: error })
      }
    }
    if (checksum !== undefined) {
      if (!/^[a-f0-9]{64}$/u.test(checksum)) {
        throw new SshWorkspaceError('SSH_WORKSPACE_RUNTIME_UNAVAILABLE', 'The desktop SSH runtime checksum is invalid.')
      }
      return await install(transport, archive, checksum, signal)
    }
  }

  const manual = await run(transport, 'command -v dsh >/dev/null 2>&1 && ALTOAIH_HOME='
    + sshProjectHome(project) + ' dsh web --help | grep -q -- '
    + (modelRelay ? '--ssh-model-relay' : '--ssh-workspace'), signal)
  if (manual.status === 0) return 'dsh'
  const detail = architecture === undefined ? 'Automatic installation requires Linux x64 or arm64.'
    : 'This desktop build is missing the matching Linux SSH runtime archive.'
  throw new SshWorkspaceError('SSH_WORKSPACE_RUNTIME_UNAVAILABLE', detail + ' The server did not provide a compatible dsh for this SSH account.')
}

async function install(transport: PasswordTransport, archive: string, checksum: string, signal: AbortSignal): Promise<string> {
  const runtime = runtimeRoot + '/' + checksum
  const isInstalled = 'test -x "$runtime/node/bin/node" && test -f "$runtime/app/lib/bin.js" && test -f "$runtime/.ready"'
  const existing = await run(transport, 'runtime=' + runtime + '\n' + isInstalled, signal)
  if (existing.status !== 0) {
    if (existing.status !== 1) {
      throw new SshWorkspaceError('SSH_WORKSPACE_INSTALL_FAILED', 'SSH could not check the runtime cache in the server account’s home directory.')
    }
    try {
      const installed = await run(transport, [
        'set -eu',
        'umask 077',
        'root=' + runtimeRoot,
        'runtime=' + runtime,
        'mkdir -p -- "$root"',
        'work=$(mktemp -d "$root/.incoming.XXXXXXXXXX")',
        'trap \'rm -rf -- "$work"\' EXIT',
        'trap \'exit 1\' HUP INT TERM',
        'cat > "$work/archive.tar.gz"',
        'cd -- "$work"',
        'printf "%s  archive.tar.gz\\n" ' + checksum + ' | sha256sum -c - >/dev/null || exit 42',
        'mkdir payload',
        'tar -xzf archive.tar.gz -C payload --no-same-owner --no-same-permissions',
        'test -x payload/node/bin/node && test -f payload/app/lib/bin.js || exit 43',
        'touch payload/.ready',
        // Atomic publication leaves a complete winner if two desktop processes connect at once.
        'mv -T -- payload "$runtime" 2>/dev/null || { ' + isInstalled + '; }',
      ].join('\n'), signal, archive)
      if (installed.status !== 0) {
        const detail = installed.status === 42 ? 'The transferred archive did not match its checksum.'
          : installed.status === 43 ? 'The archive did not contain a complete Linux runtime.'
            : 'Check available space, home directory permissions, and the server’s tar and sha256sum commands.'
        throw new SshWorkspaceError('SSH_WORKSPACE_INSTALL_FAILED', 'SSH runtime installation failed. ' + detail)
      }
    } catch (error) {
      if (error instanceof SshWorkspaceError) throw error
      throw new SshWorkspaceError('SSH_WORKSPACE_INSTALL_FAILED', 'SSH runtime transfer did not finish. Check the connection and retry.', { cause: error })
    }
  }
  return 'env PATH=' + runtime + '/node/bin:"$PATH" ' + runtime + '/node/bin/node ' + runtime + '/app/lib/bin.js'
}
