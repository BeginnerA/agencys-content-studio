/**
 * [M40] 轻松创作「立项信息」真源派生与校验。
 *
 * 决策权模型（Tier B 建议 + 预览闸门）：LLM 随方案给出立项建议（名称/载体/模板/标签/简介），
 * 本模块按平台真源逐项校验并归一——缺项静默回落（本就是自动填），越界/非法值回落并产出**可见 notes**
 * （不猜测、不静默降级），notes 追加到 assistant 回复或立项消息里。
 *
 * 立项时机：项目行在「发送一句话」时以 `status='draft'` 影子态创建（规划记账与参考素材需归属），
 * 项目列表 / 统计 / 搜索一律查不到它；点「开始制作」（confirm）时才写入完整信息并转 `active`。
 */
import { listTemplates, templateFileOf } from '../../pipeline/loader'
import {
  PROJECT_BRIEF_MAX,
  PROJECT_GENRE_VALUES,
  PROJECT_NAME_MAX,
  PROJECT_TAG_COUNT_MAX,
  PROJECT_TAG_MAX,
  projectMetaSchema,
  type CreationPlan,
  type ProjectGenre,
  type ProjectMeta,
  type ProjectMetaInput,
} from './contract'
import { isCreationTemplate } from './recipe'

/** 载体 → 项目「专业工作台默认模板」映射（与 web/src/lib/scene GENRE_DEFAULT_TPL 同源）。
 *  注意：此值只决定项目之后到专业工作台可跑的默认模板，与本次轻松创作执行模板
 *  （execution.ts 硬编码 easy-video / easy-dialogue ±review）完全解耦。 */
const GENRE_DEFAULT_TPL: Record<string, string> = {
  drama_short: 'mengbao-episode',
  note: 'note-clip',
  article: 'article-clip',
  talking_head: 'talking-clip',
  other: 'talking-clip',
}
/** 映射项不可用时的最终兜底专业模板 */
const FALLBACK_PROJECT_TEMPLATE_KEY = 'talking-clip'

/** 可作为项目专业默认模板：文件存在且非轻松创作批准链模板（conversationOnly）；真源为服务端 isCreationTemplate。 */
function isSelectableProjectTemplate(key: string): boolean {
  return !!key && templateFileOf(key) != null && !isCreationTemplate(key)
}

/** 按载体解析项目专业默认模板：映射命中且可用 → 用；否则兜底模板可用 → 用；再否则取列表首个非批准链模板；全无 → 空串。 */
export function resolveDefaultTemplateKey(genre: string): string {
  const mapped = GENRE_DEFAULT_TPL[genre]
  if (mapped && isSelectableProjectTemplate(mapped)) return mapped
  if (isSelectableProjectTemplate(FALLBACK_PROJECT_TEMPLATE_KEY)) return FALLBACK_PROJECT_TEMPLATE_KEY
  return listTemplates().find((t) => !isCreationTemplate(t.key))?.key ?? ''
}

/** 载体字典（值 + 中文标签；与 web/src/lib/scene PROJECT_GENRES 同源） */
export const PROJECT_GENRES: Array<{ value: ProjectGenre; label: string }> = [
  { value: 'drama_short', label: '短剧' },
  { value: 'note', label: '图文' },
  { value: 'article', label: '长文' },
  { value: 'talking_head', label: '口播' },
  { value: 'other', label: '其他' },
]

export function projectGenreLabel(g: string): string {
  return PROJECT_GENRES.find((x) => x.value === g)?.label ?? g
}

function uniqueTags(items: string[]): string[] {
  const out: string[] = []
  for (const t of items) {
    const s = t.trim().slice(0, PROJECT_TAG_MAX)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= PROJECT_TAG_COUNT_MAX) break
  }
  return out
}

/** 规则派生（LLM 未给 project 建议时的零成本兜底；也用作 notes 的回落值） */
export function deriveProjectMeta(plan: CreationPlan): ProjectMeta {
  // 载体：静态多图配音 → 图文；有剧情 → 短剧；其余（科普/带货口播）→ 口播
  const genre: ProjectGenre = plan.mode === 'slideshow' ? 'note' : plan.genre === 'story' ? 'drama_short' : 'talking_head'
  const name = plan.title.trim().slice(0, PROJECT_NAME_MAX) || '轻松创作作品'
  const tags = uniqueTags(['轻松创作', projectGenreLabel(genre), plan.mode === 'dynamic' ? '动态视频' : '图文配音', plan.aspectRatio === '9:16' ? '竖屏' : `${plan.aspectRatio} 画幅`])
  return {
    name,
    genre,
    templateKey: resolveDefaultTemplateKey(genre),
    tags,
    brief: (plan.summary.trim() || plan.title.trim()).slice(0, PROJECT_BRIEF_MAX),
  }
}

/** 把 projects 行现值投影为严格形（非法/缺失逐字段回落规则派生） */
export function projectMetaFromRow(row: { name: string; genre: string; templateKey: string; tags: string[]; brief: string | null }, plan: CreationPlan): ProjectMeta {
  const fb = deriveProjectMeta(plan)
  const genre = PROJECT_GENRE_VALUES.includes(row.genre as ProjectGenre) ? (row.genre as ProjectGenre) : fb.genre
  const tags = uniqueTags(row.tags ?? [])
  return projectMetaSchema.parse({
    name: row.name?.trim().slice(0, PROJECT_NAME_MAX) || fb.name,
    genre,
    templateKey: row.templateKey?.trim() || fb.templateKey,
    tags: tags.length ? tags : fb.tags,
    brief: row.brief?.trim().slice(0, PROJECT_BRIEF_MAX) || fb.brief,
  })
}

/**
 * 归一立项信息建议值。
 * - `input` 为 undefined/null 的字段：静默用 fallback（本就是「系统自动填」，无需打扰用户）
 * - 字段有值但非法（空/越界/不在字典/模板不存在）：回落 + 产出 note（不静默降级）
 * - `base` = 草稿行现值（confirm 用），缺省时用规则派生（规划首次用）
 */
export function sanitizeProjectMeta(
  input: ProjectMetaInput | undefined | null,
  plan: CreationPlan,
  base?: ProjectMeta,
): { meta: ProjectMeta; notes: string[] } {
  const fb = base ?? deriveProjectMeta(plan)
  const notes: string[] = []
  const text = (v: unknown, fallback: string, max: number, label: string): string => {
    if (v === undefined || v === null) return fallback
    const s = typeof v === 'string' ? v.trim() : ''
    if (!s) {
      notes.push(`${label}为空，已改用「${fallback}」`)
      return fallback
    }
    if (s.length > max) {
      notes.push(`${label}超过 ${max} 字，已截断`)
      return s.slice(0, max)
    }
    return s
  }
  const name = text(input?.name, fb.name, PROJECT_NAME_MAX, '项目名称')
  const brief = text(input?.brief, fb.brief, PROJECT_BRIEF_MAX, '项目简介')

  let genre = fb.genre
  if (input?.genre !== undefined && input.genre !== null) {
    const g = typeof input.genre === 'string' ? input.genre.trim() : ''
    if (PROJECT_GENRE_VALUES.includes(g as ProjectGenre)) genre = g as ProjectGenre
    else notes.push(`载体「${g || '空'}」不在平台字典，已按内容形态取「${projectGenreLabel(fb.genre)}」`)
  }

  let templateKey = fb.templateKey
  if (input?.templateKey !== undefined && input.templateKey !== null) {
    const k = typeof input.templateKey === 'string' ? input.templateKey.trim() : ''
    if (k && templateFileOf(k) && !isCreationTemplate(k)) templateKey = k
    else if (k && isCreationTemplate(k)) {
      // [B 收口] 服务端真源拒绝批准链模板进「项目专业默认」字段（与前端 filterSelectable 双保险）
      templateKey = resolveDefaultTemplateKey(genre)
      notes.push(`模板「${k}」是轻松创作批准链专用（不能在专业工作台启动），已按载体改选「${templateKey}」`)
    } else {
      templateKey = resolveDefaultTemplateKey(genre)
      notes.push(`模板「${k || '空'}」在平台不存在，已按载体回落专业默认模板「${templateKey}」`)
    }
  }

  let tags = fb.tags
  if (input?.tags !== undefined && input.tags !== null) {
    if (Array.isArray(input.tags)) {
      const list = uniqueTags(input.tags.map((t) => (typeof t === 'string' ? t : '')))
      if (list.length) {
        tags = list
        if (input.tags.filter((t) => typeof t === 'string' && t.trim()).length > PROJECT_TAG_COUNT_MAX)
          notes.push(`标签最多 ${PROJECT_TAG_COUNT_MAX} 个，已保留前 ${PROJECT_TAG_COUNT_MAX} 个`)
      } else notes.push('标签不合法（无有效文本），已按方案自动生成')
    } else notes.push('标签格式不正确，已按方案自动生成')
  }

  return { meta: projectMetaSchema.parse({ name, genre, templateKey, tags, brief }), notes }
}

/**
 * [M40] 立项信息约束注入（与 Tier A 能力约束同范式）：把载体字典与模板候选真源交给 LLM，
 * 避免它编造不存在的 templateKey；执行模板恒为 easy-video（不因此建议而改变）。
 */
export function projectMetaPrompt(): string {
  const tpls = listTemplates()
    .filter((t) => !isCreationTemplate(t.key))
    .map((t) => `${t.key}（${t.name}）`)
    .join('、')
  return [
    '【立项信息 project】给出方案时，请与 plan 同级再输出一个 project 对象（不要写进 plan 内部）：',
    '{"name":"≤60字项目名称","genre":"drama_short | note | article | talking_head | other","templateKey":"候选模板 key 之一","tags":["1-6个中文短标签，每个≤20字"],"brief":"≤500字项目简介"}',
    `- genre 是内容载体（${PROJECT_GENRES.map((g) => `${g.value}=${g.label}`).join('、')}），按内容形态选，不按题材风格选；成片为静态多图配音时选 note。`,
    `- templateKey 是该项目「之后到专业工作台可跑的默认模板」（本次制作由系统按方案固定执行，与此字段无关），只能从下列专业模板候选中选（不含轻松创作批准链模板）：${tpls}。拿不准就按载体选一个通用产出模板。`,
    '- name 用方案标题（不加书名号、不照抄用户原句）；tags/brief 只写方案中真实存在的信息，不得编造事实、平台或数据。',
    '- 立项信息由系统校验后写入项目库，不影响方案结构与费用；字段缺失时系统会自动补全。',
  ].join('\n')
}

/** notes → 可见调整说明（追加到回复/消息尾部，不覆盖原文） */
export function renderMetaNotes(notes: string[]): string {
  return notes.length ? `\n\n（立项信息已按平台真源调整：${notes.join('；')}）` : ''
}
