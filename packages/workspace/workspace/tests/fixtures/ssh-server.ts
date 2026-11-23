import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import ssh2 from 'ssh2'

/** Start a loopback SSH server that exposes one existing directory over SFTP. */
export async function startWorkspaceSshServer() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  const host = '127.0.0.1'
  const username = 'project'
  const password = 'test password'
  const directory = '/project folder'
  const sockets = new Set<ssh2.Connection>()
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    sockets.add(client)
    client.once('close', () => { sockets.delete(client) })
    client.on('error', () => {})
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === username && context.password === password) context.accept()
      else context.reject(['password'])
    })
    client.on('session', (accept) => {
      accept().on('sftp', (open) => {
        const sftp = open()
        sftp.on('STAT', (id, path) => {
          if (path === directory) {
            sftp.attrs(id, { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 })
          } else {
            sftp.status(id, ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE)
          }
        })
      })
    })
  })
  server.listen(0, host)
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a loopback listener')
  return {
    connection: { host, port: address.port, username, password },
    directory,
    async close() {
      for (const socket of sockets) socket.end()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    },
  }
}
