/** V4 framing with native tool-role admission and released physical rows. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { parseSshWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { assertV4SourceRowAdmission } from './message-sources.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'
import { assertReleasedV4Header } from './validation.ts'

function physicalV2(value: unknown) {
  const physical = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(physical) || physical['version'] !== 4) throw new SessionFormatError('expected format v4 physical header')
  const { cwd, ...fields } = physical
  // The frozen V2 framing only admits local paths. V4 owns the SSH address.
  const sshCwd = typeof cwd === 'string' && parseSshWorkspacePath(cwd) !== undefined ? cwd : undefined
  const header = { ...fields, version: 2, ...(sshCwd === undefined && cwd !== undefined ? { cwd } : {}) }
  return { header, sshCwd }
}

function logicalV4(header: SessionFormatHeader, sshCwd: string | undefined): SessionFormatHeader {
  return { ...header, version: 4, ...(sshCwd === undefined ? {} : { cwd: sshCwd }) }
}

/**
 * V4 physical encoder and decoder retain the released row framing while
 * validating the native tool-role message directly.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader(value: unknown) {
    const { header, sshCwd } = physicalV2(value)
    return logicalV4(releasedV2SessionFormatCodec.decodeHeader(header), sshCwd)
  },
  createDecoder(value, recovery) {
    const { header, sshCwd } = physicalV2(value)
    const decoder = releasedV2SessionFormatCodec.createDecoder(header, recovery)
    return {
      ...decoder,
      header: logicalV4(decoder.header, sshCwd),
      decodeRow(row, context) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent: context.emitEvent.bind(context),
        })
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    const { cwd, ...fields } = header
    const sshCwd = cwd !== undefined && parseSshWorkspacePath(cwd) !== undefined ? cwd : undefined
    const physical = releasedV2SessionFormatCodec.encodeHeader({
      ...fields, version: 2, ...(sshCwd === undefined && cwd !== undefined ? { cwd } : {}),
    }, inheritedEventCount)
    return { ...physical, version: 4, ...(sshCwd === undefined ? {} : { cwd: sshCwd }) }
  },
  encodeEvent(event: SessionFormatEvent) {
    if (event.type === 'developer/message' && event['ignorable'] === true) {
      assertV4DeveloperData(event)
      assertV4RetiredSyntax(event)
    }
    assertV4RowAdmission(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Apply native V4 admission before a scanner discards a recoverable suffix.
 * Ignorable developer payloads require reader vocabulary; physical decoding defers them.
 * @param row - parsed physical row before framing and source-event range decoding.
 * @param knownEventTypes - installed event types, supplied by native readers before tail recovery.
 */
export function assertV4RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row)) {
    if (row['type'] === 'developer/message' && row['ignorable'] === true
      && knownEventTypes?.has('developer/message') !== true) return
    assertV4DeveloperData(row as unknown as SessionFormatEvent)
  }
  assertV4SourceRowAdmission(row)
  assertV4RetiredSyntax(row)
  assertV4SystemMessageFields(row)
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'tool/result') return
  const event = row as unknown as SessionFormatEvent
  assertV4ToolResultMessage(event)
  assertV4ForkResult(event)
}
