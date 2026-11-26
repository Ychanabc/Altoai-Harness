// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, onTestFinished, vi } from 'vitest'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

usePinnedBrowserLanguages('en-US')

const test = createClientTest({
  roster: webApp.closure(['@deepseek-ai/dsh-client-ui-workspace']),
}, { mount: true })

test('the SSH workspace New Session button uses the main window Session pipeline', async ({ mock, remote, start }) => {
  const workspaceId = 'ssh-project'
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({
      type: 'baseline',
      value: {
        items: [{
          workspaceId,
          path: 'ssh://project@192.0.2.2:22/srv/project',
          title: 'Remote project',
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
  })
  mock.unary('session/create', { ok: true, value: { sessionId: 'ssh-session' } })
  mock.stream('session/follow', (_args, stream) => {
    stream.push({
      type: 'snapshot',
      header: { id: 'ssh-session', version: 4, createdAt: 1, cwd: '/srv/project', isSeeded: false },
      cursor: -1,
      records: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: {} },
    })
  })
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  onTestFinished(() => { open.mockRestore() })

  await start()
  expect(remote.session.create).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: 'New session in Remote project' }))

  await waitFor(() => {
    expect(remote.session.create).toHaveBeenCalledExactlyOnceWith({ workspaceId })
    expect(remote.session.follow).toHaveBeenCalledWith(
      expect.objectContaining({ address: { kind: 'session', sessionId: 'ssh-session' } }),
      expect.any(AbortSignal),
    )
  })
  expect(open).not.toHaveBeenCalled()
}, 60_000)

test('an SSH workspace stays in the primary sidebar when conversation creation is refused', async ({ mock, remote, start }) => {
  const workspaceId = 'ssh-project'
  const openSshWorkspace = vi.fn()
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, openSshWorkspace })
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({
      type: 'baseline',
      value: {
        items: [{
          workspaceId,
          path: 'ssh://project@192.0.2.2:22/srv/project',
          title: 'Remote project',
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
  })
  mock.unary('session/create', { ok: false, error: { code: 'workspace/ssh-unavailable', message: 'Remote chat is unavailable' } })
  await start()
  expect(remote.session.create).not.toHaveBeenCalled()
  expect(screen.queryByText('SSH connected')).toBeNull()
  expect(screen.queryByText('Remote files')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'New session in Remote project' }))
  await waitFor(() => { expect(remote.session.create).toHaveBeenCalledExactlyOnceWith({ workspaceId }) })
  expect(openSshWorkspace).not.toHaveBeenCalled()
}, 60_000)
