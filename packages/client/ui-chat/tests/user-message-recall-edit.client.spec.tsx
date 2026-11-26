// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatNode, ChatNodeViewProps, UserMessageNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { en } from '../src/client/locale.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { createUserContentFixture } from './user-content-component-fixture.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SID = brandString<SessionId>('s1')

function makeUserNode(text: string, seq = 5): ChatNode<'user'> {
  const data: UserMessageNode = {
    kind: 'user',
    messageId: brandString<MessageId>('m1'),
    seq: SessionSeq(seq),
    time: 1_700_000_000_000,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  return {
    key: `user:${seq}`,
    id: `m-${seq}`,
    target: 'chat',
    visibility: 'visible',
    kind: 'user',
    anchorSeq: SessionSeq(seq),
    data,
    location: { kind: 'session' },
  }
}

function makeSessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SID,
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    historyLoadStatus: 'idle',
    historyWasPartial: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

function renderUserMessage(options: {
  text?: string
  seq?: number
  subagent?: SessionSnapshot['subagent']
  rewindAllowed?: boolean
  recallMessage?: (seq: number, text: string) => Promise<void>
  editMessage?: (seq: number, text: string) => Promise<void>
} = {}) {
  const t = makeTranslate({ ...commonEn, ...en }) as ChatNodeViewProps<'user'>['t']
  const sessionStore = createSnapshotStore(makeSessionSnapshot({
    subagent: options.subagent ?? null,
  }))
  const useSession = bindSnapshotSelector(sessionStore)
  const useAccess: ChatNodeViewProps<'user'>['useAccess'] = (action) => {
    if (action === 'session/rewind' && options.rewindAllowed === false) return false
    return allowAllAccess.useAccess(action)
  }
  const loadImage = Object.assign(
    vi.fn(() => Promise.resolve({ url: '', revoke: () => {} })),
    { peek: vi.fn(() => undefined) },
  )
  const renderUserContent = createUserContentFixture()
  const renderFactorySlot = (name: string, input: unknown) => {
    if (name !== 'conversation.chat.user.content') throw new Error(`Unexpected factory slot: ${name}`)
    return renderUserContent(
      input as Parameters<typeof renderUserContent>[0],
      () => null,
      t,
    )
  }
  const props = {
    node: makeUserNode(options.text ?? 'Hello world', options.seq ?? 5),
    openFile: vi.fn(),
    inspectCall: undefined,
    forkAt: vi.fn(),
    recallMessage: options.recallMessage,
    editMessage: options.editMessage,
    loadImage,
    renderFactorySlot,
    renderSlotChain: () => null,
    useSession,
    useAccess,
    t,
  } as unknown as Parameters<typeof UserMessageNodeView>[0]
  return render(<UserMessageNodeView {...props} />)
}

describe('UserMessageNodeView recall & inline edit actions', () => {
  it('invokes recallMessage with seq and message text when clicking Recall', async () => {
    const recallMessage = vi.fn(() => Promise.resolve())
    const editMessage = vi.fn(() => Promise.resolve())
    renderUserMessage({ text: 'Original prompt', seq: 7, recallMessage, editMessage })

    fireEvent.click(screen.getByRole('button', { name: 'Recall' }))

    await waitFor(() => {
      expect(recallMessage).toHaveBeenCalledExactlyOnceWith(7, 'Original prompt')
    })
  })

  it('opens an inline editor on Edit, supports Escape cancel, and submits edited text', async () => {
    const recallMessage = vi.fn(() => Promise.resolve())
    const editMessage = vi.fn(() => Promise.resolve())
    renderUserMessage({ text: 'Draft one', seq: 9, recallMessage, editMessage })

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = screen.getByRole('textbox', { name: 'Edit message…' }) as HTMLTextAreaElement
    expect(editor.value).toBe('Draft one')

    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Edit message…' })).toBeNull()
    expect(editMessage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editorAgain = screen.getByRole('textbox', { name: 'Edit message…' })
    fireEvent.change(editorAgain, { target: { value: 'Draft two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & send' }))

    await waitFor(() => {
      expect(editMessage).toHaveBeenCalledOnce()
    })
    expect(editMessage.mock.calls[0]?.slice(0, 2)).toEqual([9, 'Draft two'])
  })

  it('hides Edit and Recall on subagent sessions or without session/rewind access', () => {
    const recallMessage = vi.fn(() => Promise.resolve())
    const editMessage = vi.fn(() => Promise.resolve())
    renderUserMessage({
      subagent: {
        address: { parentSessionId: brandString<SessionId>('parent'), childSessionId: SID, mode: 'one-shot' },
      },
      recallMessage,
      editMessage,
    })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Recall' })).toBeNull()

    cleanup()
    renderUserMessage({ rewindAllowed: false, recallMessage, editMessage })
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Recall' })).toBeNull()
  })

  it('displays an inline error when recall fails', async () => {
    const recallMessage = vi.fn(() => Promise.reject(new Error('Network unavailable')))
    renderUserMessage({ text: 'Will fail', seq: 3, recallMessage })

    fireEvent.click(screen.getByRole('button', { name: 'Recall' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Network unavailable')
    })
  })
})
