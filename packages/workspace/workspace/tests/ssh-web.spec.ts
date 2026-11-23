import { createHash, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { describe, expect, it } from 'vitest'
import { SshWebHost } from '../src/ssh-web.ts'

async function fixture({ denyForward = false, directoryMissing = false, manual = true } = {}) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const publicKey = ssh2.utils.parseKey(privateKey)
  if (publicKey instanceof Error || Array.isArray(publicKey)) throw new Error('Expected one SSH test key')
  const fingerprint = createHash('sha256').update(publicKey.getPublicSSH()).digest('base64')
  const api = createHttpServer((request, response) => { response.end(`remote endpoint ${request.url}`) })
  api.listen(0, '127.0.0.1')
  await once(api, 'listening')
  const apiPort = (api.address() as AddressInfo).port
  const clients = new Set<ssh2.Connection>()
  const commands: string[] = []
  const uploaded: Buffer[] = []
  let installed = false
  let passwordAttempts = 0
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => { clients.delete(client) })
    client.on('authentication', (context) => {
      if (context.method !== 'password') { context.reject(['password']); return }
      passwordAttempts++
      if (context.username === 'project' && context.password === 'test password') context.accept()
      else context.reject(['password'])
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => { acceptPty?.() })
      session.on('exec', (acceptExec, _reject, info) => {
        if (acceptExec === undefined) return
        commands.push(info.command)
        const channel = acceptExec()
        if (info.command.includes('--port 0 --no-open --ssh-workspace')) {
          channel.write(`startup output\r\ndsh web: http://127.0.0.1:${apiPort}/?token=test-remote-token\r\n`)
          return
        }
        const finish = (code: number): void => {
          channel.exit(code)
          channel.end()
        }
        if (info.command.includes('ALTOAIH_REMOTE_PLATFORM')) {
          if (!directoryMissing) channel.write('ALTOAIH_REMOTE_PLATFORM=Linux/x86_64\n')
          finish(directoryMissing ? 41 : 0)
        } else if (info.command.includes('mktemp -d')) {
          const parts: Buffer[] = []
          channel.on('data', (data: Buffer) => { parts.push(data) })
          channel.on('end', () => {
            const archive = Buffer.concat(parts)
            uploaded.push(archive)
            installed = info.command.includes(createHash('sha256').update(archive).digest('hex'))
            finish(installed ? 0 : 42)
          })
        } else if (info.command.includes('dsh web --help')) {
          finish(manual ? 0 : 1)
        } else {
          finish(installed ? 0 : 1)
        }
      })
    })
    client.on('tcpip', (accept, reject, info) => {
      if (denyForward || info.destIP !== '127.0.0.1' || info.destPort !== apiPort) { reject?.(); return }
      const channel = accept()
      if (channel === undefined) return
      const socket = createConnection({ host: '127.0.0.1', port: apiPort })
      socket.on('error', () => { channel.destroy() })
      channel.on('error', () => { socket.destroy() })
      channel.once('close', () => { socket.destroy() })
      channel.pipe(socket).pipe(channel)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    login: { host: '127.0.0.1', port: (server.address() as AddressInfo).port, username: 'project', password: 'test password', fingerprint },
    commands,
    uploaded,
    apiPort,
    passwordAttempts: () => passwordAttempts,
    disconnect: () => { for (const client of clients) client.end() },
    async [Symbol.asyncDispose]() {
      for (const client of clients) client.end()
      await Promise.all([
        new Promise<void>((resolve) => { server.close(() => resolve()) }),
        new Promise<void>((resolve) => { api.close(() => resolve()); api.closeAllConnections() }),
      ])
    },
  }
}

async function runtimeFixture(expected: string, uploaded: string) {
  const directory = await mkdtemp(join(tmpdir(), 'altoaih-archive-'))
  const archive = join(directory, 'altoaih-ssh-linux-x64.tar.gz')
  await writeFile(archive + '.sha256', createHash('sha256').update(expected).digest('hex') + '\n')
  await writeFile(archive, uploaded)
  return { directory, archive, async [Symbol.asyncDispose]() { await rm(directory, { recursive: true, force: true }) } }
}

describe('SSH project Web Host', () => {
  it('opens a pinned SSH project, forwards browser requests, and closes the desktop listener on disconnect', async () => {
    await using local = await fixture()
    const host = new SshWebHost(local.login, "/project folder/don't expand $PWD")
    try {
      const launch = new URL(await host.url)
      expect(launch.hostname).toBe('127.0.0.1')
      expect(launch.port).not.toBe(String(local.apiPort))
      expect(local.commands).toHaveLength(3)
      expect(local.commands[0]).toContain('t expand $PWD')
      expect(local.commands[2]).toContain('dsh web --host 127.0.0.1 --port 0 --no-open --ssh-workspace')
      expect(await (await fetch(launch)).text()).toBe('remote endpoint /?token=test-remote-token')
      local.disconnect()
      await host.closed
      await host.close()
      await expect(fetch(launch)).rejects.toThrow()
    } finally {
      await host.close()
    }
  })

  it('installs the desktop archive once, then reuses the matching remote runtime', async () => {
    await using local = await fixture({ manual: false })
    await using runtime = await runtimeFixture('test Linux runtime', 'test Linux runtime')
    for (const _attempt of [1, 2]) {
      const host = new SshWebHost(local.login, '/project', runtime.directory)
      try {
        const launch = await host.url
        expect(await (await fetch(launch)).text()).toBe('remote endpoint /?token=test-remote-token')
      } finally {
        await host.close()
      }
    }
    expect(local.uploaded).toEqual([Buffer.from('test Linux runtime')])
    expect(local.commands.filter(command => command.includes('/node/bin/node ') && command.includes(' web --host'))).toHaveLength(2)
    expect(local.commands.some(command => command.includes('command -v dsh'))).toBe(false)
  })

  it('stops on a mismatched archive and installs the corrected archive on retry', async () => {
    await using local = await fixture({ manual: false })
    await using runtime = await runtimeFixture('complete', 'corrupt')
    const failed = new SshWebHost(local.login, '/project', runtime.directory)
    await expect(failed.url).rejects.toMatchObject({
      code: 'SSH_WORKSPACE_INSTALL_FAILED', message: expect.stringContaining('checksum'),
    })
    expect(local.commands.some(command => command.includes(' web --host'))).toBe(false)
    await writeFile(runtime.archive, 'complete')
    const retried = new SshWebHost(local.login, '/project', runtime.directory)
    try {
      await expect(retried.url).resolves.toContain('127.0.0.1')
      expect(local.uploaded).toEqual([Buffer.from('corrupt'), Buffer.from('complete')])
    } finally {
      await retried.close()
    }
  })

  it('identifies a missing project separately from a forwarding restriction', async () => {
    await using missing = await fixture({ directoryMissing: true })
    await expect(new SshWebHost(missing.login, '/missing').url).rejects.toMatchObject({
      code: 'SSH_WORKSPACE_DIRECTORY_UNAVAILABLE',
    })
    expect(missing.commands).toHaveLength(1)
    await using blocked = await fixture({ denyForward: true })
    await expect(new SshWebHost(blocked.login, '/project').url).rejects.toMatchObject({
      code: 'SSH_WORKSPACE_FORWARD_UNAVAILABLE',
    })
  })

  it('rejects a changed server key before sending the stored password or starting the Host', async () => {
    await using local = await fixture()
    const host = new SshWebHost({ ...local.login, fingerprint: Buffer.alloc(32).toString('base64') }, '/project')
    try {
      await expect(host.url).rejects.toThrow('pinned fingerprint')
      expect(local.passwordAttempts()).toBe(0)
      expect(local.commands).toEqual([])
    } finally {
      await host.close()
    }
  })
})
