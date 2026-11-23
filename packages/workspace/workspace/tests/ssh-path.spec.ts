import { describe, expect, it } from 'vitest'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath } from '../src/paths.ts'
import { formatSshWorkspacePath, parseSshWorkspacePath, probeSshDirectory, sshWorkspaceAuthority } from '../src/ssh-path.ts'
import { startWorkspaceSshServer } from './fixtures/ssh-server.ts'

describe('SSH workspace paths', () => {
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
