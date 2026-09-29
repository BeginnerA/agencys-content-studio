/**
 * BGM 情绪聚合（阶段二）：把本 run 台词/分镜情绪汇成「单条情绪文本 + embedding 向量」，供 pickBgm 消费。
 * - 真源：run 内音频资产 params.emotionHint（strict-tts/tts 已落位，形态 `基调词——六维细节`）。
 * - 单一真源词表在 bgm-library（canonicalizeMood 归一）；本模块只做「频次聚合 + 向量编码」。
 * - 红线：无情绪数据 / embedding 不可用 → vec=null，选曲退化纯时长，绝不断链（不抛错）。
 * - 本期单轨配乐：全片情绪聚合为一条主导文本（"1 bgm/run" 不变量），逐段交叉配乐列后续。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db'
import { assets } from '../db/schema'
import { embed, embeddingStatus } from './embedding'
import { canonicalizeMood } from './bgm-library'
import type { StepContext } from '../pipeline/context'

/** emotion_hint `基调词——六维细节` → 取破折号前基调词（无破折号取全串） */
export function baseToneWord(hint: string | null | undefined): string {
  const t = (hint ?? '').trim()
  if (!t) return ''
  return t.split(/——|—|–/)[0]!.trim()
}

/**
 * 纯聚合（探针直测，零 DB / 零模型）：情绪提示列表 → 主导情绪词（频次降序，同频首次出现序）+ 情绪文本。
 * 基调词优先命中枚举，退化再试整串；均不命中 → 忽略该条。
 */
export function aggregateMoodTokens(hints: Array<string | null | undefined>): { moods: string[]; counts: Record<string, number>; text: string | null } {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const h of hints) {
    const base = baseToneWord(h)
    const canon = canonicalizeMood(base) || canonicalizeMood(h ?? '')
    if (!canon) continue
    if (!counts.has(canon)) order.push(canon)
    counts.set(canon, (counts.get(canon) ?? 0) + 1)
  }
  const moods = [...counts.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])).map(([m]) => m)
  const text = moods.length ? `${moods.join('、')} 情绪` : null
  return { moods, counts: Object.fromEntries(counts), text }
}

export interface RunMood { text: string | null; vec: number[] | null }

/** 聚合本 run 台词情绪 → 情绪文本 + 向量（模型缺失/无情绪 → vec=null，调用方退化纯时长，不断链） */
export async function aggregateRunMood(ctx: StepContext): Promise<RunMood> {
  const rows = await db
    .select({ params: assets.params })
    .from(assets)
    .where(and(eq(assets.runId, ctx.run.id), eq(assets.kind, 'audio'), isNull(assets.deletedAt)))
  const hints: string[] = []
  for (const r of rows) {
    try {
      const p = r.params ? (JSON.parse(r.params) as Record<string, unknown>) : {}
      const eh = p['emotionHint']
      if (typeof eh === 'string' && eh.trim()) hints.push(eh)
    } catch {
      /* 脏 params 宽容跳过 */
    }
  }
  const { text } = aggregateMoodTokens(hints)
  if (!text) return { text: null, vec: null }
  try {
    const st = await embeddingStatus()
    if (!st.ready) return { text, vec: null }
    const vec = await embed(text)
    return { text, vec }
  } catch {
    return { text, vec: null }
  }
}
