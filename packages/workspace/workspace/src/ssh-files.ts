/** Read-only project explorer using the pinned SSH connection's SFTP subsystem. */
import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { PasswordTransport, type PasswordTransportOptions } from './ssh-transport.ts'

export type SshFilesResult =
  | { readonly kind: 'list'; readonly entries: readonly { readonly name: string; readonly kind: 'directory' | 'file' | 'other' }[] }
  | { readonly kind: 'read'; readonly text: string }

const previewLimit = 128 * 1024
type FileEntry = Extract<SshFilesResult, { kind: 'list' }>['entries'][number]

function call<T>(start: (done: (error: Error | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => start((error, value) => error ? reject(error) : resolve(value)))
}

function projectPath(path: string): boolean {
  return path.length <= 4096 && (path === '' || path.split('/').every(
    name => name !== '' && name !== '.' && name !== '..' && !name.includes('\0'),
  ))
}

/** Browse or preview a path relative to the project, independently of its chat runtime. */
export async function sshFiles(
  login: Omit<PasswordTransportOptions, 'timeoutMs'>, root: string, path: string,
  kind: SshFilesResult['kind'], caller: AbortSignal,
): Promise<SshFilesResult> {
  if (!projectPath(path) || (kind === 'read' && path === '')) throw new Error('Invalid relative SSH file path')
  const timeoutMs = 12_000
  const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)])
  signal.throwIfAborted()
  const transport = new PasswordTransport({ ...login, timeoutMs }, () => {})
  const abort = (): void => { transport.destroy() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const sftp = await transport.sftp(signal)
    sftp.on('error', abort)
    const canonicalRoot = await call<string>(done => sftp.realpath(root, done))
    const target = await call<string>(done => sftp.realpath(posix.join(canonicalRoot, path), done))
    const relative = posix.relative(canonicalRoot, target)
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      throw new Error('The path points outside the remote workspace')
    }
    if (kind === 'read') return { kind, text: await preview(sftp, target, signal) }
    const entries = await call<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>(done => sftp.readdir(target, done))
    return { kind, entries: entries.filter(entry => entry.filename !== '.' && entry.filename !== '..'
      && !entry.filename.includes('/') && projectPath(entry.filename)).map<FileEntry>(entry => ({
      name: entry.filename,
      kind: entry.attrs.isDirectory() ? 'directory' : entry.attrs.isFile() ? 'file' : 'other',
    })).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory')
      || a.name.localeCompare(b.name)) }
  } finally {
    signal.removeEventListener('abort', abort)
    transport.destroy()
  }
}

async function preview(sftp: SFTPWrapper, target: string, signal: AbortSignal): Promise<string> {
  const attrs = await call<Parameters<Parameters<SFTPWrapper['stat']>[1]>[1]>(done => sftp.stat(target, done))
  if (!attrs.isFile() || attrs.size > previewLimit) throw new Error('Preview requires a regular text file of at most 128 KiB')
  const handle = await call<Buffer>(done => sftp.open(target, 'r', done))
  const bytes = Buffer.alloc(previewLimit + 1)
  let size = 0
  try {
    while (size < bytes.byteLength) {
      signal.throwIfAborted()
      const count = await call<number>(done => sftp.read(handle, bytes, size, bytes.byteLength - size, size, done))
      if (count === 0) break
      size += count
    }
  } finally {
    if (!signal.aborted) await new Promise<void>((resolve, reject) => sftp.close(handle, error => error ? reject(error) : resolve()))
  }
  const content = bytes.subarray(0, size)
  if (size > previewLimit || content.includes(0)) throw new Error('Preview requires a regular text file of at most 128 KiB')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error('Preview requires a UTF-8 text file')
  }
}
