import { describe, expect, it } from 'vitest'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath } from '../src/paths.ts'
import { formatSshWorkspacePath, parseSshWorkspacePath, probeSshDirectory, sshWorkspaceAuthority } from '../src/ssh-path.ts'
import { startWorkspaceSshServer } from './fixtures/ssh-server.ts'
import { sshFiles } from '../src/ssh-files.ts'

describe('SSH workspace paths', () => {
  it('lists and previews remote files over pinned SFTP without an installed remote application', async () => {
    const { connection, directory, close } = await startWorkspaceSshServer()
    try {
      const login = { ...connection, fingerprint: await probeSshDirectory(connection, directory) }
      const signal = AbortSignal.timeout(12_000)
      await expect(sshFiles(login, directory, '', 'list', signal)).resolves.toEqual({
        kind: 'list', entries: [{ name: 'src', kind: 'directory' }],
      })
      await expect(sshFiles(login, directory, 'src', 'list', signal)).resolves.toEqual({
        kind: 'list', entries: [{ name: 'test file.txt', kind: 'file' }],
      })
      await expect(sshFiles(login, directory, 'src/test file.txt', 'read', signal)).resolves.toEqual({
        kind: 'read', text: 'remote file content\n',
      })
      await expect(sshFiles(login, directory, '../outside', 'list', signal)).rejects.toThrow('Invalid relative SSH file path')
      await expect(sshFiles(login, directory, 'outside', 'list', signal)).rejects.toThrow('outside the remote workspace')
      await expect(sshFiles({ ...login, fingerprint: 'another key' }, directory, '', 'list', signal))
        .rejects.toThrow('pinned fingerprint')
    } finally {
      await close()
    }
  }, 15_000)
  it('parses ssh://alias/abs/dir', () => {
    expect(parseSshWorkspacePath('ssh://prod-box/home/user/project')).toEqual({
      host: 'prod-box',
      remotePath: '/home/user/project',
    })
    expect(parseSshWorkspacePath('/home/user/project')).toBeUndefined()
    expect(parseSshWorkspacePath('ssh://prod-box')).toBeUndefined()
  })

  it('formats and treats the spelling as fully qualified', () => {
    expect(formatSshWorkspacePath('prod-box', 'home/user/project')).toBe('ssh://prod-box/home/user/project')
    expect(formatSshWorkspacePath('prod-box', '/home/user/project/')).toBe('ssh://prod-box/home/user/project')
    expect(fullyQualifiedWorkspacePath('ssh://prod-box/home/user/project', 'linux')).toBe(true)
    expect(defaultWorkspaceTitle('ssh://prod-box/home/user/project')).toBe('project')
  })

  it('uses SFTP to verify a password, a directory and the saved host key', async () => {
    const { connection, directory, close } = await startWorkspaceSshServer()
    try {
      expect(sshWorkspaceAuthority(connection)).toBe(`project@127.0.0.1:${connection.port}`)
      const fingerprint = await probeSshDirectory(connection, directory)
      await expect(probeSshDirectory(connection, directory, fingerprint)).resolves.toBe(fingerprint)
      await expect(probeSshDirectory(connection, '/missing', fingerprint)).rejects.toThrow('directory does not exist')
      await expect(probeSshDirectory({ ...connection, password: 'wrong' }, directory, fingerprint)).rejects.toThrow('authentication failed')
      await expect(probeSshDirectory(connection, directory, 'different key')).rejects.toThrow('host key changed')
    } finally {
      await close()
    }
  }, 15_000)
})
