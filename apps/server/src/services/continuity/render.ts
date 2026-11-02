import { ContinuityError, type EntryDoc, type EntryRef, type Item, type ItemRef } from './contract'
import { foldEntries } from './fold'

export const RENDERER_VERSION = 1
const AUDIENCE_KEY = 'audience'
const HEADER = '【剧情连续性台账 v1】以下各区间彼此隔离；简报/设定等其他参考资料不构成本台账认证的事实。'
const EPISTEMIC: Record<KnowledgeItem['epistemic'], string> = { knows: '知道', believes: '以为', unaware: '不知', unknown: '认知不明' }

/** Minor 1 (gate): item values and knower labels cannot forge 台账 sections — fullwidth brackets
 * are neutralized and CR/LF flattened so a rendered line can never start a new section or line item. */
function neutral(text: string): string {
  return text.replaceAll('【', '〖').replaceAll('】', '〗').replace(/[\r\n]+/g, ' ')
}

type Packed = { ref: EntryRef; doc: EntryDoc }[]
type KnowledgeItem = Extract<Item, { channel: 'knowledge' }>

function section(title: string, lines: string[]): string {
  return `【${title}】\n${lines.length ? lines.map(line => `${line}\n`).join('') : '（无）\n'}`
}

/** Pure five-section renderer over folded heads: 事实/人物认知/观众认知/伏笔 + optional 编剧计划.
 * The audience is its own epistemic subject (reserved knower key); retract is an omission, never a rollback.
 * Every rendered line carries its exact source ItemRef so provenance survives packing. */
export function renderContinuity(packed: Packed, includePlans: boolean): string {
  const folded = foldEntries(packed)
  const itemOf = (ref: ItemRef): Item => {
    const item = packed.find(packedEntry => packedEntry.ref.entryId === ref.entryId)?.doc.items.find(i => i.id === ref.itemId)
    if (!item) throw new ContinuityError('continuity_dependency_invalid', 409)
    return item
  }
  const pick = (refs: ItemRef[], test: (item: Item) => boolean): ItemRef[] => refs.filter(ref => test(itemOf(ref)))
  const lines = (refs: ItemRef[], closed: boolean): string[] => refs.map(ref => {
    const item = itemOf(ref)
    const owner = packed.find(packedEntry => packedEntry.ref.entryId === ref.entryId)!
    const provenance = `（来源 entry:${ref.entryId} item:${ref.itemId}）`
    const mark = closed ? '（已回收）' : ''
    if (item.channel === 'knowledge') {
      const knower = owner.doc.subjects.find(subject => subject.key === item.knower)?.label ?? item.knower
      return `- ${neutral(knower)}·${EPISTEMIC[item.epistemic]}：${neutral(item.value)}${mark}${provenance}`
    }
    return `- ${neutral(item.value)}${mark}${provenance}`
  })
  const isFact = (item: Item): boolean => item.channel === 'fact' && item.type !== 'thread'
  const isThread = (item: Item): boolean => item.channel === 'fact' && item.type === 'thread'
  const isKnowledge = (item: Item): boolean => item.channel === 'knowledge' && item.knower !== AUDIENCE_KEY
  const isAudience = (item: Item): boolean => item.channel === 'knowledge' && item.knower === AUDIENCE_KEY
  const isPlan = (item: Item): boolean => item.channel === 'plan'
  const parts = [
    HEADER,
    section('事实', [...lines(pick(folded.current, isFact), false), ...lines(pick(folded.closed, isFact), true)]),
    section('人物认知', [...lines(pick(folded.current, isKnowledge), false), ...lines(pick(folded.closed, isKnowledge), true)]),
    section('观众认知', [...lines(pick(folded.current, isAudience), false), ...lines(pick(folded.closed, isAudience), true)]),
    section('伏笔', [...lines(pick(folded.current, isThread), false), ...lines(pick(folded.closed, isThread), true)]),
  ]
  if (includePlans) parts.push(section('编剧计划（编剧参考，非既定事实）',
    [...lines(pick(folded.current, isPlan), false), ...lines(pick(folded.closed, isPlan), true)]))
  return parts.join('')
}
