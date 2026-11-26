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
        const status = ssh2.utils.sftp.STATUS_CODE
        const folder = { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }
        const content = Buffer.from('remote file content\n')
        const file = { ...folder, mode: 0o100644, size: content.length }
        const filePath = directory + '/src/test file.txt'
        const directoryHandle = Buffer.from([1])
        const subdirectoryHandle = Buffer.from([2])
        const fileHandle = Buffer.from([3])
        const firstRead = new Set<number>()
        sftp.on('REALPATH', (id, path) => {
          const target = path === directory + '/outside' ? '/outside' : path
          sftp.name(id, [{ filename: target, longname: target, attrs: folder }])
        })
        sftp.on('STAT', (id, path) => {
          if (path === directory || path === directory + '/src') sftp.attrs(id, folder)
          else if (path === filePath) sftp.attrs(id, file)
          else sftp.status(id, status.NO_SUCH_FILE)
        })
        sftp.on('OPENDIR', (id, path) => {
          if (path === directory) sftp.handle(id, directoryHandle)
          else if (path === directory + '/src') sftp.handle(id, subdirectoryHandle)
          else sftp.status(id, status.NO_SUCH_FILE)
        })
        sftp.on('READDIR', (id, handle) => {
          const number = handle.readUInt8()
          if (firstRead.has(number)) { sftp.status(id, status.EOF); return }
          firstRead.add(number)
          const name = number === 1 ? 'src' : 'test file.txt'
          sftp.name(id, [{ filename: name, longname: name, attrs: number === 1 ? folder : file }])
        })
        sftp.on('OPEN', (id, path) => {
          if (path === filePath) sftp.handle(id, fileHandle)
          else sftp.status(id, status.NO_SUCH_FILE)
        })
        sftp.on('FSTAT', (id) => { sftp.attrs(id, file) })
        sftp.on('READ', (id, _handle, offset, length) => {
          if (offset >= content.length) sftp.status(id, status.EOF)
          else sftp.data(id, content.subarray(offset, offset + length))
        })
        sftp.on('CLOSE', (id) => { sftp.status(id, status.OK) })
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
