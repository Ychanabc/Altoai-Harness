/** Client-side SSH workspace path spelling (no Node fs). */

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
  const collapsed = abs.replace(/\/{2,}/g, '/')
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
  return `ssh://${alias}${trimmed}`
}

/**
 * Whether both fields can become a stored SSH workspace path.
 * @param host - OpenSSH host alias.
 * @param remotePath - Remote directory.
 */
export function canFormatSshWorkspacePath(host: string, remotePath: string): boolean {
  const alias = host.trim()
  const remote = remotePath.trim()
  return alias !== '' && remote !== '' && !alias.includes('/')
}
