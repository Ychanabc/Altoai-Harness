/** Node carrier for an authenticated remote Host reached through a private SSH tunnel. */
import { createWebConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import WebSocket from 'ws'
import { RemoteStreamMuxClient } from './client/stream-client.ts'

export interface LoopbackRemote {
  call(endpoint: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  stream(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncIterable<unknown>
  close(): Promise<void>
}

/**
 * Exchange only the remote Host's launch token. Its cookie stays in this Node
 * process and is sent only through the same SSH loopback endpoint.
 * @param launchUrl - SSH workspace runtime launch URL.
 * @param signal - lifetime of authentication.
 * @returns authenticated unary and streaming carrier.
 */
export async function connectLoopbackRemote(launchUrl: string, signal: AbortSignal): Promise<LoopbackRemote> {
  const entry = new URL(launchUrl)
  if (entry.protocol !== 'http:' || entry.hostname !== '127.0.0.1' || entry.port === ''
    || entry.username !== '' || entry.password !== '' || entry.pathname !== '/' || !entry.searchParams.has('token')) {
    throw new Error('Invalid SSH tunnel address')
  }
  const response = await fetch(entry, { redirect: 'manual', signal })
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  await response.body?.cancel()
  if (response.status !== 303 || !cookie) throw new Error('SSH runtime authentication failed')
  const base = entry.origin + '/'
  const rpc = createWebConnectionRpc((path, options) => {
    const headers = new Headers(options.headers)
    headers.set('cookie', cookie)
    return fetch(new URL(path, base), { ...options, headers, redirect: 'error' })
  })
  const streams = new RemoteStreamMuxClient((path) => {
    const url = new URL(path, base)
    url.protocol = 'ws:'
    return new WebSocket(url, { headers: { cookie }, handshakeTimeout: 10_000, followRedirects: false })
  })
  streams.start()
  return {
    call: (endpoint, args, requestSignal) => rpc.call('/api', endpoint, { args }, requestSignal),
    stream: (endpoint, args, requestSignal, uplink) => streams.open(endpoint, { args }, requestSignal, uplink),
    close: () => streams.close(),
  }
}
