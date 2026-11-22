import { describe, expect, it } from 'vitest'
import { defaultWorkspaceTitle, fullyQualifiedWorkspacePath } from '../src/paths.ts'
import { formatSshWorkspacePath, parseSshWorkspacePath } from '../src/ssh-path.ts'

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
})
