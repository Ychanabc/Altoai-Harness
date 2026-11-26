/** SSH workspace directory identity and connection checks. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { promisify } from 'node:util'
import { posix } from 'node:path'
import { parseSshWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import ssh2 from 'ssh2'

export { parseSshWorkspacePath, type SshWorkspaceLocation } from '@deepseek-ai/dsh-util-workspace-path'

const run = promisify(execFile)
const timeoutMs = 12_000

/** Password authentication supplied only to the Host during Workspace creation. */
export interface SshWorkspaceConnection {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
}

/** Connection update input; omitting password reuses the stored credential for the existing SSH Workspace. */
export interface SshWorkspaceUpdateConnection {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password?: string
}

/**
 * Build a stable SSH authority for the Workspace path and Host credential store.
 * @param connection - Endpoint and password presented during creation.
 * @returns The username, IP address and port, without the password.
 */
export function sshWorkspaceAuthority(
  connection: Pick<SshWorkspaceConnection, 'host' | 'port' | 'username'> & { readonly password?: string },
): string {
  const host = connection.host.trim().toLowerCase()
  const username = connection.username.trim()
  if (isIP(host) === 0 || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
    || !/^[a-zA-Z0-9_.@-]{1,128}$/u.test(username)
    || (connection.password !== undefined && (connection.password.length === 0 || connection.password.length > 4096))) {
    throw new Error('Enter a valid SSH IP address, port, account, and password')
  }
  const address = isIP(host) === 6 ? new URL(`http://[${host}]`).hostname : host
  return `${encodeURIComponent(username)}@${address}:${connection.port}`
}

/**
 * Confirm a remote directory over SFTP.
 * @param connection - Host, account and password for the connection.
 * @param path - Absolute directory to check.
 * @param trustedFingerprint - Previously observed key; rejects a change when provided.
 * @returns The fingerprint of the server that authenticated and served the directory.
 */
export async function probeSshDirectory(
  connection: SshWorkspaceConnection,
  path: string,
  trustedFingerprint?: string,
): Promise<string> {
  const client = new ssh2.Client()
  let fingerprint = ''
  let changedKey = false
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSH connection or directory check timed out')), timeoutMs)
      client.on('error', () => {
        clearTimeout(timer)
        reject(new Error(changedKey ? 'SSH server host key changed' : 'SSH connection or password authentication failed'))
      })
      client.once('close', () => {
        clearTimeout(timer)
        reject(new Error('SSH connection closed before the directory check completed'))
      })
      client.once('ready', () => {
        client.sftp((error, sftp) => {
          if (error) {
            clearTimeout(timer)
            reject(new Error('The SSH server did not open an SFTP session'))
            return
          }
          sftp.stat(path, (statError, attributes) => {
            clearTimeout(timer)
            if (statError || !attributes.isDirectory()) {
              reject(new Error('The remote directory does not exist or is inaccessible'))
              return
            }
            resolve(fingerprint)
          })
        })
      })
      client.connect({
        host: connection.host.trim(),
        port: connection.port,
        username: connection.username.trim(),
        password: connection.password,
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => {
          fingerprint = createHash('sha256').update(key).digest('base64')
          changedKey = trustedFingerprint !== undefined && trustedFingerprint !== fingerprint
          return !changedKey
        },
      })
    })
  } finally {
    client.destroy()
  }
}

/**
 * Build the stored SSH workspace path.
 * @param host - OpenSSH destination or managed SSH authority.
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
    const quotedPath = "'" + parsed.remotePath.replaceAll("'", "'\"'\"'") + "'"
    await run('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '--', parsed.host,
      `test -d ${quotedPath}`,
    ], { timeout: 20_000 })
  } catch {
    throw new Error(`cannot read remote directory ${parsed.host}:${parsed.remotePath}`)
  }
  return canonical
}
