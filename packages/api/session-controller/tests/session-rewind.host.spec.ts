import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { buildRewindSeed, SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    resolveSelection: async () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

function controllerAgents(ctx: Context): ApiSessionAgentController {
  const agents = new ApiSessionAgentController(ctx)
  vi.spyOn(agents, 'composeAgent').mockResolvedValue({ setup: () => {} })
  return agents
}

function resolvedHandle(ctx: Context, sessionId: SessionId): AgentHandle {
  const select = vi.fn()
  return {
    agent: { id: sessionId, status: 'idle', ctx, model: { select } } as unknown as Agent,
    dispose: () => Promise.resolve(),
  }
}

describe('buildRewindSeed', () => {
  it('returns an empty seed when rewinding before Turn 1 with only its enqueue splice ahead', () => {
    const msg1 = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const events: SessionEvent[] = [
      { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1, data: { target: 'next-turn', start: 0, inserted: [msg1] } },
      { type: 'turn/start', seq: SessionSeq(1), time: 2, data: { turn: 1 } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: SessionSeq(3), time: 4, data: msg1, surfaceOp: 'append' },
      { type: 'turn/end', seq: SessionSeq(4), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(buildRewindSeed(events, SessionSeq(3))).toEqual([])
  })

  it('keeps Turn 1 intact when rewinding before Turn 2 and cancels any queued inbox leftover', () => {
    const msg1 = createUserMessage({ content: [{ type: 'text', text: 'turn 1' }], source: { kind: 'user' } })
    const msg2 = createUserMessage({ content: [{ type: 'text', text: 'turn 2 queued early' }], source: { kind: 'user' } })
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, data: msg1, surfaceOp: 'append' },
      // User queued msg2 before Turn 1 ended:
      { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3, data: { target: 'next-turn', start: 0, inserted: [msg2] } },
      { type: 'turn/end', seq: SessionSeq(3), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: SessionSeq(4), time: 5, data: { turn: 2 } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(5), time: 6, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', seq: SessionSeq(6), time: 7, data: msg2, surfaceOp: 'append' },
    ]
    const seed = buildRewindSeed(events, SessionSeq(6))
    expect(seed.map(e => [e.seq, e.type])).toEqual([
      [0, 'turn/start'],
      [1, 'user/message'],
      [2, 'agent/inbox/spliced'],
      [3, 'turn/end'],
      [4, 'agent/inbox/spliced'],
    ])
    const cancel = seed[4]
    expect(cancel?.type).toBe('agent/inbox/spliced')
    if (cancel?.type === 'agent/inbox/spliced') {
      expect(cancel.data).toEqual({
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      })
    }
  })

  it('closes an open turn with interrupted closers when rewinding before a mid-turn steering message', () => {
    const msg1 = createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } })
    const steer = createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } })
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, data: msg1, surfaceOp: 'append' },
      { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: SessionSeq(3), time: 4, data: steer, surfaceOp: 'append' },
    ]
    const seed = buildRewindSeed(events, SessionSeq(3))
    expect(seed.map(e => [e.seq, e.type])).toEqual([
      [0, 'turn/start'],
      [1, 'user/message'],
      [2, 'step/start'],
      [3, 'step/end'],
      [4, 'turn/end'],
    ])
  })
})

describe('SessionCommandController.rewind', () => {
  it('replaces the session in-place, preserves workspace position & pin state, and deletes the old session', async () => {
    const ctx = await baseContext()
    const source = ctx.sessions.create(brandString<SessionId>('source-session'), { meta: { cwd: '/workspace' } })
    const msg1 = createUserMessage({ content: [{ type: 'text', text: 'first turn' }], source: { kind: 'user' } })
    const msg2 = createUserMessage({ content: [{ type: 'text', text: 'second turn' }], source: { kind: 'user' } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', msg1, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [msg2] })
    source.append('turn/start', { turn: 2 })
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const secondUserEvent = source.append('user/message', msg2, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const attachSession = vi.fn(() => Promise.resolve())
    const insertSessionBefore = vi.fn(() => Promise.resolve())
    const pinSession = vi.fn(() => Promise.resolve())
    const deleteSession = vi.fn(() => Promise.resolve(true))
    const workspace = {
      id: 'ws-1' as WorkspaceId,
      sessionIds: [source.id],
      attachSession,
      insertSessionBefore,
    } as unknown as Workspace
    ctx.provide('workspaceRegistry', {
      sshProjectHost: false,
      pinnedSessionIds: [source.id],
      list: () => [workspace],
      pinSession,
      deleteSession,
    } as never)

    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
      (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
    )
    const controller = new SessionCommandController(ctx, controllerAgents(ctx), '/default')

    const rewound = await controller.rewind({ sessionId: source.id, beforeSeq: secondUserEvent.seq })
    expect(rewound.sessionId).toMatch(/^session-/)
    expect(rewound.sessionId).not.toBe(source.id)

    const createOpts = create.mock.calls[0]?.[0]
    expect(createOpts?.parentSource).toBeUndefined()
    expect(createOpts?.inheritedEventCount).toBeUndefined()
    expect(createOpts?.meta).toEqual({ cwd: '/workspace' })
    expect(createOpts?.seed?.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])

    expect(attachSession).toHaveBeenCalledExactlyOnceWith(rewound.sessionId)
    expect(insertSessionBefore).toHaveBeenCalledExactlyOnceWith(rewound.sessionId, source.id)
    expect(pinSession).toHaveBeenCalledExactlyOnceWith(rewound.sessionId)
    expect(deleteSession).toHaveBeenCalledExactlyOnceWith(source.id, { stopActivity: true })

    await ctx.fiber.dispose()
  })

  it('refuses non-user events, bad seqs, and subagent sessions', async () => {
    const ctx = await baseContext()
    const source = ctx.sessions.create(brandString<SessionId>('source-session'), { meta: { cwd: '/workspace' } })
    source.append('turn/start', { turn: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const subagent = ctx.sessions.create(brandString<SessionId>('subagent-session'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: source.id },
    })
    const subMsg = subagent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'child' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    ctx.provide('workspaceRegistry', { sshProjectHost: false, pinnedSessionIds: [], list: () => [] } as never)
    const controller = new SessionCommandController(ctx, controllerAgents(ctx), '/default')

    await expect(controller.rewind({ sessionId: source.id, beforeSeq: -1 })).rejects.toMatchObject({
      code: 'gateway/bad-request',
    })
    await expect(controller.rewind({ sessionId: source.id, beforeSeq: 0 })).rejects.toMatchObject({
      code: 'session/rewind-unavailable',
    })
    await expect(controller.rewind({ sessionId: subagent.id, beforeSeq: subMsg.seq })).rejects.toMatchObject({
      code: 'session/agent-busy',
    })

    await ctx.fiber.dispose()
  })
})
