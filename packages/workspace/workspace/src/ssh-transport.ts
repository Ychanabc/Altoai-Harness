/** Password-authenticated workspace connections with an explicitly pinned server key. */

import { createHash } from 'node:crypto'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import ssh2 from 'ssh2'

/** Credentials are resolved by the connection owner and never passed to the remote shell. */
export interface PasswordTransportOptions {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly fingerprint: string
  readonly timeoutMs: number
}

/** Owns one SSH transport and its helper and Unix-stream channels. */
export class PasswordTransport {
  private readonly socket = new Socket()
  private readonly client = new ssh2.Client()
  private readonly ready = Promise.withResolvers<void>()
  private changedKey = false
  private connected = false

  private readonly closedResolvers = Promise.withResolvers<void>()

  /** Settles when the underlying TCP connection and its channels have closed. */
  get closed(): Promise<void> { return this.closedResolvers.promise }

  /**
   * @param options - SSH endpoint and expected SHA-256 server fingerprint.
   * @param onFailure - invoked if the transport fails after authentication.
   */
  constructor(options: PasswordTransportOptions, onFailure: (error: Error) => void) {
    this.client.once('ready', () => {
      this.connected = true
      this.ready.resolve()
    })
    this.client.on('error', (cause: Error) => {
      if (this.connected) {
        onFailure(new Error('SSH transport failed; remote outcomes and cleanup are unknown', { cause }))
      } else {
        const message = this.changedKey ? 'SSH server host key does not match its pinned fingerprint'
          : 'SSH connection or password authentication failed'
        this.ready.reject(new Error(message, { cause }))
      }
    })
    this.socket.once('close', () => {
      this.closedResolvers.resolve()
      if (this.connected) onFailure(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown'))
      else this.ready.reject(new Error('SSH connection closed before authentication completed'))
    })
    void this.ready.promise.catch(() => {
      // The helper opener retains and propagates the authentication failure.
    })

    this.socket.connect(options.port, options.host)
    this.client.connect({
      sock: this.socket,
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      readyTimeout: options.timeoutMs,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        this.changedKey = createHash('sha256').update(key).digest('base64') !== options.fingerprint
        return !this.changedKey
      },
    })
  }

  /**
   * Run the installed helper over a single SSH exec channel.
   * @param command - invocation assembled from the configured helper paths.
   * @param signal - startup deadline or disposal.
   * @param terminal - request a controlling terminal for a foreground server.
   * @returns The bidirectional channel and its separate diagnostic stream.
   */
  async exec(command: string, signal: AbortSignal, terminal = false): Promise<ssh2.ClientChannel> {
    return await this.openChannel<ssh2.ClientChannel>((callback) => { this.client.exec(command, { pty: terminal }, callback) },
      signal, (channel) => { channel.close() })
  }

  /** Open the SFTP subsystem on this authenticated transport. */
  async sftp(signal: AbortSignal): Promise<ssh2.SFTPWrapper> {
    return this.openChannel<ssh2.SFTPWrapper>((callback) => { this.client.sftp(callback) }, signal, (channel) => { channel.end() })
  }

  /**
   * Forward one local browser connection to the remote loopback listener.
   * @param port - remote listener port.
   * @param sourcePort - local browser connection port.
   * @param signal - channel allocation lifetime.
   * @returns The SSH channel for one TCP connection.
   */
  async forwardLoopback(port: number, sourcePort: number, signal: AbortSignal): Promise<Duplex> {
    return await this.openChannel<ssh2.ClientChannel>(
      (callback) => { this.client.forwardOut('127.0.0.1', sourcePort, '127.0.0.1', port, callback) },
      signal, (channel) => { channel.close() },
    )
  }

  /**
   * Allocate a remote loopback listener for desktop model calls.
   * @param localPort - desktop loopback listener that accepts the forwarded connections.
   * @param signal - startup cancellation. The listener closes with this transport.
   * @returns the server-allocated port.
   */
  async forwardModels(localPort: number, signal: AbortSignal): Promise<number> {
    await this.ready.promise
    signal.throwIfAborted()
    const port = await new Promise<number>((resolve, reject) => {
      const abort = (): void => { reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      this.client.forwardIn('127.0.0.1', 0, (error, remotePort) => {
        signal.removeEventListener('abort', abort)
        if (error) reject(new Error('The SSH server refused remote loopback forwarding for the desktop model.', { cause: error }))
        else resolve(remotePort)
      })
    })
    this.client.on('tcp connection', (info, accept, reject) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== port) {
        reject()
        return
      }
      const channel = accept()
      const socket = new Socket()
      channel.on('error', () => socket.destroy())
      socket.on('error', () => channel.destroy())
      channel.once('close', () => socket.destroy())
      socket.once('close', () => channel.destroy())
      socket.connect(localPort, '127.0.0.1')
      channel.pipe(socket).pipe(channel)
    })
    return port
  }

  /** Close the SSH transport, including every pending or open channel. */
  destroy(): void {
    try { this.client.destroy() } catch (_clientDestroyFailed) { /* socket teardown below closes the transport */ }
    this.socket.destroy()
    this.closedResolvers.resolve()
  }

  private async openChannel<T extends ssh2.ClientChannel | ssh2.SFTPWrapper>(
    open: (callback: (error: Error | undefined, channel: T) => void) => void,
    signal: AbortSignal,
    close: (channel: T) => void,
  ): Promise<T> {
    return await new Promise((resolve, reject) => {
      const aborted = (): void => { finish(); reject(signal.reason) }
      const finish = (): void => { signal.removeEventListener('abort', aborted) }
      signal.throwIfAborted()
      signal.addEventListener('abort', aborted, { once: true })
      void this.ready.promise.then(() => {
        if (signal.aborted) return
        open((error, channel) => {
          finish()
          if (error) reject(new Error('SSH server did not open the requested channel', { cause: error }))
          else if (signal.aborted) close(channel)
          else resolve(channel)
        })
      }).catch((error: unknown) => { finish(); reject(error) })
    })
  }
}
