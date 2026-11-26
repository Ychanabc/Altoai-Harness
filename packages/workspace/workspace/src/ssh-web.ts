/** Starts a remote Web Host and forwards its loopback listener through SSH. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { PasswordTransport } from './ssh-transport.ts'
import { prepareSshRuntime, quoteSsh, sshProjectHome, SshWorkspaceError } from './ssh-runtime.ts'
import type { SshWorkspaceConnection } from './ssh-path.ts'

const loopback = '127.0.0.1'
const startupTimeoutMs = 45_000
const channelTimeoutMs = 10_000

const deploymentTimeoutMs = 180_000

/** A foreground remote Web Host and its private, loopback-only SSH forward. */
export class SshWebHost {
  private readonly lifetime = new AbortController()
  private readonly sockets = new Set<Socket>()
  private readonly transport: PasswordTransport
  private readonly server = createServer((socket) => { void this.forward(socket) })
  private readonly modelServer: Server | undefined
  private readonly modelToken = randomBytes(32).toString('hex')
  private remotePort = 0
  private closing: Promise<void> | undefined

  /** The local browser launch URL, including the remote Host's process-scoped authentication token. */
  readonly url: Promise<string>

  /** Settles when the SSH transport is closed. */
  get closed(): Promise<void> { return this.transport.closed }

  /**
   * @param login - previously saved SSH credentials and pinned server fingerprint.
   * @param project - absolute project directory on the server.
   * @param runtimeDirectory - desktop archive directory, or undefined to use a compatible server-installed dsh.
   * @param models - optional desktop model carrier forwarded only to this SSH connection.
   */
  constructor(
    login: SshWorkspaceConnection & { fingerprint: string },
    project: string,
    runtimeDirectory?: string,
    models?: RequestListener,
  ) {
    this.transport = new PasswordTransport({ ...login, timeoutMs: channelTimeoutMs }, (error) => {
      void this.close(error)
    })
    this.server.maxConnections = 64
    this.server.on('error', (error) => { void this.close(error) })
    if (models !== undefined) {
      const allowed = Buffer.from('Bearer ' + this.modelToken)
      this.modelServer = createHttpServer((request, response) => {
        const authorization = Buffer.from(request.headers.authorization ?? '')
        if (authorization.length !== allowed.length || !timingSafeEqual(authorization, allowed)) {
          response.writeHead(401, { connection: 'close' }).end()
          return
        }
        models(request, response)
      })
      this.modelServer.maxConnections = 16
      this.modelServer.on('error', (error) => { void this.close(error) })
    }
    this.url = this.start(project, runtimeDirectory).catch(async (error: unknown) => {
      await this.close(error)
      throw error
    })
  }

  /**
   * Close the local listener, browser connections, and foreground SSH channel.
   * @param reason - failure propagated to pending startup or channel allocation.
   * @returns completion of local resource release.
   */
  close(reason?: unknown): Promise<void> {
    this.closing ??= this.closeOnce(reason)
    return this.closing
  }

  private async closeOnce(reason: unknown): Promise<void> {
    this.lifetime.abort(reason)
    for (const socket of this.sockets) socket.destroy()
    this.transport.destroy()
    const serverClosed = new Promise<void>((resolve) => {
      if (!this.server.listening) { resolve(); return }
      this.server.close(() => resolve())
    })
    const modelsClosed = new Promise<void>((resolve) => {
      if (this.modelServer === undefined || !this.modelServer.listening) { resolve(); return }
      this.modelServer.close(() => resolve())
      this.modelServer.closeAllConnections()
    })
    await Promise.race([
      Promise.all([serverClosed, modelsClosed, this.transport.closed]),
      new Promise<void>((resolve) => { setTimeout(resolve, 2_000).unref() }),
    ])
  }

  private async start(project: string, runtimeDirectory: string | undefined): Promise<string> {
    const deploymentSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(deploymentTimeoutMs)])
    const cli = await prepareSshRuntime(this.transport, project, runtimeDirectory, deploymentSignal, this.modelServer !== undefined)
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(startupTimeoutMs)])
    const modelEnv = await this.startModels(signal)
    const modelFlag = modelEnv === '' ? '' : ' --ssh-model-relay'
    const command = `cd -- ${quoteSsh(project)} && umask 077 && ALTOAIH_HOME=${sshProjectHome(project)} ${modelEnv}exec ${cli} web --host ${loopback} --port 0 --no-open --ssh-workspace ${quoteSsh(project)}${modelFlag}`
    const startupFailure = 'The remote Altoai runtime did not start. Check that the SSH account can run programs and that the server supports the bundled Linux runtime.'
    const channel = await this.transport.exec('sh -c ' + quoteSsh(command), signal, true).catch((cause: unknown) => {
      throw new SshWorkspaceError('SSH_WORKSPACE_START_FAILED', 'The SSH server refused to start the remote workspace terminal.', { cause })
    })
    channel.stderr.resume()
    channel.on('error', (error: Error) => { void this.close(error) })
    channel.once('close', () => {
      void this.close(new SshWorkspaceError('SSH_WORKSPACE_START_FAILED', startupFailure))
    })
    // A PTY may combine startup diagnostics with the URL. Accept only the authenticated loopback entry.
    const entry = await this.readEntry(channel, signal).catch((cause: unknown) => {
      if (cause instanceof SshWorkspaceError) throw cause
      throw new SshWorkspaceError('SSH_WORKSPACE_START_FAILED', startupFailure, { cause })
    })
    this.remotePort = Number(entry.port)
    const probeSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(channelTimeoutMs)])
    try {
      const probe = await this.transport.forwardLoopback(this.remotePort, 0, probeSignal)
      probe.on('error', () => { probe.destroy() })
      probe.destroy()
    } catch (cause) {
      throw new SshWorkspaceError('SSH_WORKSPACE_FORWARD_UNAVAILABLE', 'The remote runtime started, but the SSH server refused the loopback TCP tunnel. Check its TCP forwarding policy.', { cause })
    }
    const listening = once(this.server, 'listening', { signal })
    this.server.listen({ host: loopback, port: 0, signal: this.lifetime.signal })
    await listening
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Could not open the local SSH tunnel')
    entry.port = String(address.port)
    return entry.href
  }

  private async startModels(signal: AbortSignal): Promise<string> {
    if (this.modelServer === undefined) return ''
    const listening = once(this.modelServer, 'listening', { signal })
    this.modelServer.listen({ host: loopback, port: 0, signal: this.lifetime.signal })
    await listening
    const address = this.modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('Could not open the desktop model listener')
    const port = await this.transport.forwardModels(address.port, signal)
    return `ALTOAIH_SSH_MODEL_PORT=${port} ALTOAIH_SSH_MODEL_TOKEN=${this.modelToken} `
  }

  private async readEntry(channel: Duplex, signal: AbortSignal): Promise<URL> {
    return await new Promise<URL>((resolve, reject) => {
      const lines = createInterface({ input: channel, crlfDelay: Infinity })
      let bytes = 0
      const finish = (): void => {
        channel.off('data', count)
        signal.removeEventListener('abort', abort)
        lines.close()
        channel.resume()
      }
      const abort = (): void => { finish(); reject(signal.reason) }
      const count = (chunk: Buffer): void => {
        bytes += chunk.length
        if (bytes > 1024 * 1024) {
          finish()
          reject(new Error('Remote Altoai Host produced too much output before becoming ready'))
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      channel.prependListener('data', count)
      lines.on('line', (line) => {
        const match = /(?:^|\s)dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)\s*$/u.exec(line)
        if (match?.[1] === undefined) return
        const entry = URL.parse(match[1])
        if (entry === null || entry.port === '' || entry.pathname !== '/' || !entry.searchParams.get('token')) return
        finish()
        resolve(entry)
      })
      if (signal.aborted) abort()
    })
  }

  private async forward(socket: Socket): Promise<void> {
    this.sockets.add(socket)
    socket.pause()
    const lifetime = new AbortController()
    socket.on('error', () => { socket.destroy() })
    socket.once('close', () => {
      this.sockets.delete(socket)
      lifetime.abort()
    })
    try {
      const signal = AbortSignal.any([this.lifetime.signal, lifetime.signal, AbortSignal.timeout(channelTimeoutMs)])
      const channel = await this.transport.forwardLoopback(this.remotePort, socket.remotePort ?? 0, signal)
      channel.on('error', () => { socket.destroy() })
      channel.once('close', () => { socket.destroy() })
      socket.once('close', () => { channel.destroy() })
      socket.pipe(channel).pipe(socket)
    } catch (_channelUnavailable) {
      socket.destroy()
    }
  }
}
