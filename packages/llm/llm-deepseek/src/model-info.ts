/** Protocol-independent model capabilities and reasoning choices. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/types'
import type { LlmModelBadge, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions, MessagesReasoningEffort } from './types.ts'

const OFF_REASONING_EFFORT = brandString<ReasoningEffortId>('off')
const LOW_REASONING_EFFORT = brandString<ReasoningEffortId>('low')
const HIGH_REASONING_EFFORT = brandString<ReasoningEffortId>('high')
const MAX_REASONING_EFFORT = brandString<ReasoningEffortId>('max')
const REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
  {
    id: LOW_REASONING_EFFORT,
    name: 'Low',
    description: 'Prefer for routine or latency-sensitive tasks.',
  },
  {
    id: HIGH_REASONING_EFFORT,
    name: 'High',
    description: 'The default balance for most tasks.',
  },
  {
    id: MAX_REASONING_EFFORT,
    name: 'Max',
    description: 'Reserve for the hardest quality-first tasks.',
  },
] as const
const SITE_REASONING_EFFORTS = {
  off: REASONING_EFFORTS[0],
  low: REASONING_EFFORTS[1],
  medium: { id: brandString<ReasoningEffortId>('medium'), name: 'Medium' },
  high: REASONING_EFFORTS[2],
  xhigh: { id: brandString<ReasoningEffortId>('xhigh'), name: 'Extra high' },
  max: REASONING_EFFORTS[3],
} satisfies Record<MessagesReasoningEffort, { id: ReasoningEffortId; name: string; description?: string }>

/** Resolve the advertised levels and default used by both the picker and the request serializer.
 * @param connection - validated route defaults.
 * @param model - selected catalog entry, if any.
 * @returns reasoning metadata for the selected model.
 */
export function modelReasoning(connection: DeepSeekConnectionOptions, model?: DeepSeekCatalogModel): {
  efforts: readonly { id: ReasoningEffortId; name: string; description?: string }[]
  defaultEffort: ReasoningEffortId
} {
  const declared = model?.messagesReasoningEfforts
  const routeDefault = connection.defaults.reasoningEffort ?? (connection.defaults.thinking === 'disabled' ? 'off' : 'high')
  if (declared !== undefined && declared[0] !== undefined) {
    const defaultEffort = declared.includes(routeDefault) ? routeDefault : declared[0]
    return { efforts: declared.map(effort => SITE_REASONING_EFFORTS[effort]), defaultEffort: SITE_REASONING_EFFORTS[defaultEffort].id }
  }
  return connection.defaults.thinking === 'disabled'
    ? { efforts: OFF_ONLY_REASONING_EFFORTS, defaultEffort: OFF_REASONING_EFFORT }
    : { efforts: REASONING_EFFORTS, defaultEffort: SITE_REASONING_EFFORTS[routeDefault].id }
}

const OFF_ONLY_REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
] as const

/** Advertise one catalog entry.
 * @param provider - registered provider id.
 * @param model - advisory catalog entry.
 * @param badge - selector badge a model listing declares for the entry.
 * @returns selector metadata.
 */
export function catalogModelInfo(provider: string, model: DeepSeekCatalogModel, badge?: LlmModelBadge): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
    ...badge === undefined ? {} : { badge },
  }
}

/** Resolve model capabilities against one configuration generation.
 * @param connection - validated connection facts.
 * @param provider - registered provider id.
 * @param model - requested wire model id.
 * @returns effective model metadata for this operation.
 */
export function modelInfo(
  connection: DeepSeekConnectionOptions,
  provider: string,
  model: string,
): LlmResolvedModelInfo {
  const configured = connection.models.find(entry => entry.id === model)
  const contextWindow = configured?.contextWindow
    ?? connection.defaultContextWindow
  return {
    // An uncatalogued endpoint is safely treated as text-only. Declaring an
    // unverified image capability would let the host persist input that the
    // endpoint may reject on every later turn.
    ...configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text' as const] }
      : catalogModelInfo(provider, configured),
    context: { contextWindow },
    defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    ...configured?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
    ...configured?.toolUpdate === undefined ? {} : { toolUpdate: configured.toolUpdate },
    reasoning: modelReasoning(connection, configured),
  }
}
