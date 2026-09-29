/**
 * 正版曲库标签规范（BGM 入库单一真源）：情绪/风格/分轨词表 + 同名侧车 `*.bgm.json` 解析（纯函数，探针直测）。
 *
 * 设计红线：
 * - 模块零依赖 DB / embedding / HTTP——只做「文件名 → 结构化元数据」的纯解析；
 *   情绪向量（embedding）由 smart-bgm.importLibraryTrack 落 params.moodEmbedding（阶段二 pickBgm 消费）。
 * - 向后兼容：侧车缺失 → 返回 null（调用方按「无情绪标签的纯时长候选」入库，逐字节 = 现行为）。
 * - 授权溯源（license）缺失仅告警不阻断（合规可见，不改变可播性）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 情绪枚举（对齐既有台词 emotion_hint「基调词——六维细节」语义；选曲按此聚合与匹配） */
export const BGM_MOODS = ['紧张', '温情', '反转', '欢快', '悲伤', '悬疑', '燃', '治愈', '庄严', '日常'] as const
/** 风格枚举（可扩展；未知风格原样保留进 embedding 文本，不作丢弃） */
export const BGM_STYLES = ['国风', '钢琴', '管弦', '电子', 'Lo-fi', '民谣', '嘻哈', '摇滚', '氛围'] as const
/** 分轨形态：无人声纯音乐（BGM 首选）优先入库 */
export const BGM_STEMS = ['full', 'instrumental', 'vocal'] as const

export type BgmStem = (typeof BGM_STEMS)[number]

export interface BgmLicense {
  source: string | null // 曲多多 / Mureka / 自购 / 存量库存 ...
  order_id: string | null
  scope: string | null // commercial / overseas / personal ...
  expires: string | null
}

/** 侧车解析产物（结构化后、规范化前的原始标签集合保留供 embedding 文本用） */
export interface BgmMeta {
  mood: string[] // 规范化情绪（命中枚举者；未命中原样入 raw_moods）
  raw_moods: string[] // 侧车给的全部情绪词（含非枚举词，供 embedding 文本兜底）
  style: string[]
  raw_styles: string[]
  stems: BgmStem | null
  bpm: number | null
  desc: string | null
  license: BgmLicense | null
}

/** 情绪同义词 → 枚举映射（纯函数；命中枚举返回自身，命中同义词返回目标，否则 null） */
const MOOD_SYNONYMS: Record<string, (typeof BGM_MOODS)[number]> = {
  急迫: '紧张', 紧绷: '紧张', 惊悚: '紧张', 焦灼: '紧张', tension: '紧张', tense: '紧张',
  温暖: '温情', 温馨: '温情', 柔情: '温情', 亲情: '温情', warm: '温情', tender: '温情',
  转折: '反转', 逆转: '反转', 惊变: '反转', twist: '反转',
  欢乐: '欢快', 明快: '欢快', 轻快: '欢快', 活泼: '欢快', happy: '欢快', upbeat: '欢快', cheerful: '欢快',
  哀伤: '悲伤', 悲怆: '悲伤', 伤感: '悲伤', 忧伤: '悲伤', sad: '悲伤',
  悬念: '悬疑', 神秘: '悬疑', 诡异: '悬疑', suspense: '悬疑', mystery: '悬疑',
  热血: '燃', 激昂: '燃', 振奋: '燃', epic: '燃', hype: '燃',
  疗愈: '治愈', 舒缓: '治愈', 平静: '治愈', 安神: '治愈', calm: '治愈', healing: '治愈',
  宏大: '庄严', 神圣: '庄严', 肃穆: '庄严', solemn: '庄严',
  生活: '日常', 轻松: '日常', 惬意: '日常', casual: '日常', daily: '日常',
}
export function canonicalizeMood(token: string): string | null {
  const t = (token || '').trim()
  if (!t) return null
  if ((BGM_MOODS as readonly string[]).includes(t)) return t
  const lower = t.toLowerCase()
  if ((BGM_MOODS as readonly string[]).includes(lower)) return lower
  return MOOD_SYNONYMS[t] ?? MOOD_SYNONYMS[lower] ?? null
}

/** 词表归一（纯函数）：接受 string | string[] | null，逗号/顿号/分号切分，去空去重 */
function toTokenList(value: unknown): string[] {
  const raw: string[] = []
  if (typeof value === 'string') raw.push(...value.split(/[,，、;；/|]/))
  else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') raw.push(...v.split(/[,，、;；/|]/))
  const out: string[] = []
  for (const r of raw) {
    const t = r.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 侧车 JSON 解析（纯函数，探针直测）：非法/空 → null（调用方回退文件名兜底）。
 * mood 既接受枚举也接受同义词（映射入 meta.mood），非枚举词原样进 raw_moods。
 */
export function parseBgmSidecarJson(raw: string | null | undefined): BgmMeta | null {
  if (!raw || !raw.trim()) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const rawMoods = toTokenList(obj['mood'])
  const rawStyles = toTokenList(obj['style'])
  const moods = rawMoods.map((m) => canonicalizeMood(m)).filter((m): m is string => m !== null)
  const stemsRaw = typeof obj['stems'] === 'string' ? obj['stems'].trim().toLowerCase() : ''
  const stems = (BGM_STEMS as readonly string[]).includes(stemsRaw) ? (stemsRaw as BgmStem) : null
  const bpm = Number(obj['bpm'])
  const lic = obj['license']
  const license: BgmLicense | null =
    lic && typeof lic === 'object'
      ? {
          source: typeof (lic as Record<string, unknown>)['source'] === 'string' ? String((lic as Record<string, unknown>)['source']).trim() || null : null,
          order_id: typeof (lic as Record<string, unknown>)['order_id'] === 'string' ? String((lic as Record<string, unknown>)['order_id']).trim() || null : null,
          scope: typeof (lic as Record<string, unknown>)['scope'] === 'string' ? String((lic as Record<string, unknown>)['scope']).trim() || null : null,
          expires: typeof (lic as Record<string, unknown>)['expires'] === 'string' ? String((lic as Record<string, unknown>)['expires']).trim() || null : null,
        }
      : null
  const hasSignal = rawMoods.length > 0 || rawStyles.length > 0 || stems !== null || typeof obj['desc'] === 'string'
  if (!hasSignal && !license) return null // 空壳侧车 → 视作无
  return {
    mood: [...new Set(moods)],
    raw_moods: rawMoods,
    style: rawStyles,
    raw_styles: rawStyles,
    stems,
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    desc: typeof obj['desc'] === 'string' && obj['desc'].trim() ? obj['desc'].trim() : null,
    license,
  }
}

/**
 * 文件名内联提示兜底（纯函数，探针直测）：`[mood=紧张,反转|style=电子]` → 部分 meta；无匹配 → null。
 * 供侧车文件缺失时的轻量标注（人在环最快路径）。
 */
export function metaFromFilename(name: string): BgmMeta | null {
  const m = /\[([^\]]*)\]/.exec(name || '')
  if (!m) return null
  const body = m[1]!
  const moodSeg = /mood=([^|]*)/i.exec(body)
  const styleSeg = /style=([^|]*)/i.exec(body)
  if (!moodSeg && !styleSeg) return null
  const rawMoods = toTokenList(moodSeg?.[1] ?? '')
  const rawStyles = toTokenList(styleSeg?.[1] ?? '')
  const moods = rawMoods.map((x) => canonicalizeMood(x)).filter((x): x is string => x !== null)
  return {
    mood: [...new Set(moods)],
    raw_moods: rawMoods,
    style: rawStyles,
    raw_styles: rawStyles,
    stems: null,
    bpm: null,
    desc: null,
    license: null,
  }
}

/** 侧车文件路径：{audio}.bgm.json 与音频同名同目录 */
export function bgmSidecarPath(audioAbs: string): string {
  const dir = dirname(audioAbs)
  const base = audioAbs.slice(dir.length + 1)
  const stem = base.replace(/\.[^.]+$/, '')
  return join(dir, `${stem}.bgm.json`)
}

/** 情绪/风格描述文本（embedding 输入，纯函数）：主导情绪 + 次要 + 风格 + desc；无任何信号 → null */
export function buildTrackMoodText(meta: BgmMeta | null): string | null {
  if (!meta) return null
  const moods = meta.mood.length ? meta.mood : meta.raw_moods
  const styles = meta.style.length ? meta.style : meta.raw_styles
  const parts: string[] = []
  if (moods.length) parts.push(`${moods.join('、')} 情绪`)
  if (styles.length) parts.push(styles.join('、'))
  if (meta.desc) parts.push(meta.desc)
  const text = parts.join('；').trim()
  return text || null
}

/** 授权溯源是否缺失（合规可见性判定，纯函数） */
export function hasLicense(meta: BgmMeta | null): boolean {
  return !!meta?.license?.source
}

/**
 * 读取音频同名侧车（fs）：优先 JSON 侧车，缺则文件名兜底。
 * 返回 meta + 侧车原文哈希（幂等重算 embedding 用，无侧车则哈希空串）。
 */
export function readBgmMeta(audioAbs: string, name: string): { meta: BgmMeta | null; sidecarHash: string } {
  const sidecar = bgmSidecarPath(audioAbs)
  if (existsSync(sidecar)) {
    try {
      const text = readFileSync(sidecar, 'utf8')
      const meta = parseBgmSidecarJson(text)
      if (meta) return { meta, sidecarHash: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) }
    } catch {
      /* 侧车不可读 → 文件名兜底 */
    }
  }
  return { meta: metaFromFilename(name), sidecarHash: '' }
}
