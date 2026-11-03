/**
 * 角色状态条目解析与命中判定（纯函数）。
 * 出图锚定注入与实体参考图分层选择共用同一套匹配语义，避免两处漂移：
 * states 条目形如「{剧情节点}：{状态短语}」，节点可为「第N场」「第N集」定位词或自由文本。
 */

/**
 * states 条目解析（纯函数）：首个「：」/「:」分割为 { node, phrase }；
 * 无分隔符 → node=全串、phrase=''（两侧空白剔除；非字符串入参视为空条目）。
 */
export function parseStateEntry(s: unknown): { node: string; phrase: string } {
  const raw = typeof s === 'string' ? s.trim() : ''
  if (!raw) return { node: '', phrase: '' }
  const i = raw.search(/[：:]/)
  if (i < 0) return { node: raw, phrase: '' }
  return { node: raw.slice(0, i).trim(), phrase: raw.slice(i + 1).trim() }
}

/** 定位词数值解析：阿拉伯数字或中文数字（一~九十九，含十/二十/三十五）；不可解析 → null */
function numFromToken(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const m = /^(?:([一二三四五六七八九])?十)([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? cn[m[1]]! : 1) * 10 + (m[2] ? cn[m[2]]! : 0)
  return cn[s] ?? null
}

/** states 命中档位：scene=场次定位词 / episode=集数定位词 / text=无定位词按文本包含 */
export type StateMatchMode = 'scene' | 'episode' | 'text'

/** states 定位词：第N场 / 第N场次 / 第N集（N = 阿拉伯数字或中文数字一至九十九） */
const STATE_SCENE_RE = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*场(?:次)?/
const STATE_EPISODE_RE = /第\s*(\d{1,3}|[一二三四五六七八九十]{1,3})\s*集/

/**
 * 单条 states 命中判定（纯函数，供探针直接 import 断言）：
 * 1) 节点含「第N场/第N场次」（阿拉伯或中文数字）→ 与 ctx.scene 数值相等判命中（scene 缺失 → 不命中，**不做文本兜底**）；
 * 2) 否则节点含「第N集」→ 与 ctx.episode 相等判命中（episode 缺失 → 不命中）；
 * 3) 否则（无定位词）→ 节点串包含于 ctx.text 判命中。
 * 恒返回 { hit, mode, node, phrase }，mode = 实际生效档位。
 */
export function matchStateEntry(
  entry: string,
  ctx: { scene?: number; episode?: number; text?: string },
): { hit: boolean; mode: StateMatchMode; node: string; phrase: string } {
  const { node, phrase } = parseStateEntry(entry)
  const sceneHit = STATE_SCENE_RE.exec(node)
  if (sceneHit) {
    const n = numFromToken(sceneHit[1]!)
    return { hit: n !== null && typeof ctx.scene === 'number' && ctx.scene === n, mode: 'scene', node, phrase }
  }
  const epHit = STATE_EPISODE_RE.exec(node)
  if (epHit) {
    const n = numFromToken(epHit[1]!)
    return { hit: n !== null && typeof ctx.episode === 'number' && ctx.episode === n, mode: 'episode', node, phrase }
  }
  const text = typeof ctx.text === 'string' ? ctx.text : ''
  return { hit: !!node && text.includes(node), mode: 'text', node, phrase }
}
