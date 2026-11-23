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

  /** Settles when the underlying TCP connection and its channels have closed. */
  readonly closed = new Promise<void>(resolve => this.socket.once('close', () => resolve()))

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
    return await this.openChannel((callback) => { this.client.exec(command, { pty: terminal }, callback) }, signal)
  }

  /**
   * Forward one local browser connection to the remote loopback listener.
   * @param port - remote listener port.
   * @param sourcePort - local browser connection port.
   * @param signal - channel allocation lifetime.
   * @returns The SSH channel for one TCP connection.
   */
  async forwardLoopback(port: number, sourcePort: number, signal: AbortSignal): Promise<Duplex> {
    return await this.openChannel((callback) => { this.client.forwardOut('127.0.0.1', sourcePort, '127.0.0.1', port, callback) }, signal)
  }

  /** Close the SSH transport, including every pending or open channel. */
  destroy(): void {
    this.socket.destroy()
  }

  private async openChannel(
    open: (callback: (error: Error | undefined, channel: ssh2.ClientChannel) => void) => void,
    signal: AbortSignal,
  ): Promise<ssh2.ClientChannel> {
    return await new Promise((resolve, reject) => {
      const aborted = (): void => { finish(); reject(signal.reason) }
      const finish = (): void => { signal.removeEventListener('abort', aborted) }
      signal.throwIfAborted()
      signal.addEventListener('abort', aborted, { once: true })
      void this.ready.promise.then(() => {
        if (signal.aborted) return
        open((error, channel) => {
          finish()
          if (error) reject(new Error('SSH server did not open the requested helper channel', { cause: error }))
          else if (signal.aborted) channel.close()
          else resolve(channel)
        })
      }).catch((error: unknown) => { finish(); reject(error) })
    })
  }
}
