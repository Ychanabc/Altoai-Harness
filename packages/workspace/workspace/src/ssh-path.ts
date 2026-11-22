/** SSH workspace path spelling: `ssh://<OpenSSH-alias>/<absolute-remote-dir>`. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { posix } from 'node:path'

const run = promisify(execFile)

/** One parsed SSH workspace location. */
export interface SshWorkspaceLocation {
  /** Existing OpenSSH host alias. */
  host: string
  /** Absolute directory on that host. */
  remotePath: string
}

/**
 * Parse a stored SSH workspace path.
 * @param path - Candidate workspace path.
 * @returns host and remote directory, or undefined when the spelling is not SSH.
 */
export function parseSshWorkspacePath(path: string): SshWorkspaceLocation | undefined {
  if (!path.startsWith('ssh://')) return undefined
  const rest = path.slice('ssh://'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const host = rest.slice(0, slash).trim()
  const remotePath = rest.slice(slash)
  if (host === '' || !remotePath.startsWith('/')) return undefined
  return { host, remotePath }
}

/**
 * Build the stored SSH workspace path.
 * @param host - OpenSSH host alias.
 * @param remotePath - Remote directory; a missing leading slash is added.
 * @returns `ssh://alias/abs/path`.
 */
export function formatSshWorkspacePath(host: string, remotePath: string): string {
  const alias = host.trim()
  const remote = remotePath.trim()
  const abs = remote.startsWith('/') ? remote : `/${remote}`
  const normalized = posix.normalize(abs)
  return `ssh://${alias}${normalized === '/' ? '/' : normalized.replace(/\/$/, '')}`
}

/**
 * Probe the remote host and return the canonical SSH workspace path.
 * @param path - `ssh://alias/abs/dir`.
 * @returns the canonical stored path.
 */
export async function verifySshWorkspacePath(path: string): Promise<string> {
  const parsed = parseSshWorkspacePath(path)
  if (parsed === undefined) throw new TypeError(`Workspace path is not an SSH location: '${path}'`)
  const canonical = formatSshWorkspacePath(parsed.host, parsed.remotePath)
  try {
    await run('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      parsed.host,
      'test', '-d', parsed.remotePath,
    ], { timeout: 20_000 })
  } catch {
    throw new Error(`cannot read remote directory ${parsed.host}:${parsed.remotePath}`)
  }
  return canonical
}
