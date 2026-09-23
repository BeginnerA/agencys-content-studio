/**
 * [M35 · G7] 自然语言 → 模板推荐（本地 embedding 零成本）。
 *
 * 背景：`ProjectFormModal` 建项目时靠 `GENRE_DEFAULT_TPL` 静态映射 + 用户手选；
 * `easy-create` 首页 idea 是硬编码 example。15 套模板都有 `name / description / genre / scene`
 * 但用户自然语言创意无法映射到「哪套模板最合适」。
 *
 * 方案（用户三轮 AskUserQuestion 拍板）：
 * - **启动时预计算 + 内存 Map**：`refreshTemplateVectors()` 调 `listTemplates()` +
 *   `embed("{name}。{description}。体裁：{genre}。场景：{scene}")` 得 normalize 向量存 Map；
 *   模板增删改（saveTemplate/deleteTemplate）fire-and-forget 刷新。
 * - **推荐端点**：query text → embed → cosine 排序 top-K。
 * - **零磁盘持久化 / 零新表 / 零网络**：向量随进程生灭，重启重算 2–3 秒可接受。
 *
 * fallback 三态：
 * - `embedding` ready → 语义匹配（source='embedding'，`ready:true`）
 * - embedding 未 ready / 加载失败 → 关键词命中（source='keyword'，`ready:false`）
 * - 均无命中 → 空列表（source='empty'）
 *
 * 关键词表（`KEYWORDS`）：手工按 15 套模板 name/description 高频动词/名词摘取，
 * 覆盖用户常见一句话创意（不做语义扩展，只挡「embedding 未 ready 时也能给合理建议」）。
 */
import { listTemplates } from '../pipeline/loader'
import type { TemplateMeta } from '../pipeline/types'
import { cosine, embed, embeddingStatus } from './embedding'
import { isCreationTemplate } from './creation-chat/recipe'

/** 可推荐模板 = 全量模板剔除轻松创作批准链（easy-*）：它们只接受对话页 recipe 快照，
 *  手动建项目/启动无法运行，推荐出去只会把用户引向死路（与专业端选卡 `?picker=1` 同一判据）。 */
function selectableTemplates(): TemplateMeta[] {
  return listTemplates().filter((m) => !isCreationTemplate(m.key))
}

export interface RecommendItem {
  key: string
  name: string
  score: number
}
export type RecommendSource = 'embedding' | 'keyword' | 'empty'
export interface RecommendResult {
  items: RecommendItem[]
  source: RecommendSource
  ready: boolean
  error?: string
}

interface TemplateVector {
  key: string
  name: string
  genre: string
  scene?: string
  vector: number[]
}

const vectors = new Map<string, TemplateVector>()
let loading: Promise<void> | null = null
let lastError: string | null = null

/** 关键词回退表（embedding 未 ready 或加载失败时使用；命中数 = 输入 text 出现的关键词个数） */
const KEYWORDS: Record<string, string[]> = {
  'mengbao-episode': ['短剧成片', '分集成片', '萌宝', '剧本成片', '带配音字幕', '分镜出图', '短剧单集'],
  'quick-video': ['快速出片', '免审直出', '快脚本', '30 秒成片'],
  'talking-clip': ['口播', '对白', '口播视频', '配音文案'],
  'topic-radar': ['选题', '雷达', '找选题', '选题清单', '选题库'],
  'novel-adapt': ['小说改编', '小说剧本', '改编小说', '章节切分'],
  'novel-audit': ['改编回查', '小说回查', '忠实度', '一致性审计'],
  'video-reverse': ['视频反推', '反推分镜', '参考视频', '时间轴反推', '视频解析'],
  'series-setup': ['整剧立项', '系列立项', '角色建档', '设定包', '分集地图'],
  'video-plan': ['策划案', '单条策划', '五节策划', '视觉方向'],
  'platform-adapt': ['多平台适配', '平台适配', '八平台', '平台改写', '风险标注'],
  'translate-export': ['翻译', '出海翻译', '目标语言', '译文导出'],
  'note-clip': ['图文笔记', '小红书', '封面配图', '图文'],
  'article-clip': ['深度长文', '长文', '文章', '头图'],
  'review-restock': ['复盘', '回灌', '发布记录复盘', '数据复盘'],
}

/** 参与 embed 的文本：name + description + genre + scene（保持规模小、语义丰富） */
function embedTextOf(m: TemplateMeta): string {
  return `${m.name}。${m.description ?? ''}。体裁：${m.genre}。场景：${m.scene ?? ''}`
}

async function doRefresh(): Promise<void> {
  try {
    const st = await embeddingStatus()
    if (!st.ready) {
      lastError = st.error ?? 'embedding 未就绪'
      vectors.clear()
      return
    }
    const metas = selectableTemplates()
    const next = new Map<string, TemplateVector>()
    for (const m of metas) {
      const vector = await embed(embedTextOf(m))
      next.set(m.key, { key: m.key, name: m.name, genre: m.genre, scene: m.scene, vector })
    }
    vectors.clear()
    for (const [k, v] of next) vectors.set(k, v)
    lastError = null
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    vectors.clear()
  }
}

/** 是否已完成 embedding 预计算（true 时 recommend 走 cosine 路径） */
export function recommendReady(): boolean {
  return vectors.size > 0
}

/** 上次刷新的错误信息（若有；仅观测，不参与决策） */
export function recommendLastError(): string | null {
  return lastError
}

/** 刷新 embedding 向量（幂等：并发调用共享同一 inflight promise） */
export async function refreshTemplateVectors(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    try {
      await doRefresh()
    } finally {
      loading = null
    }
  })()
  return loading
}

/** 关键词匹配打分：每命中一个关键词 +1；命中密度 = 命中数 / 关键词表长度（避免长表模板天然高分） */
function keywordMatch(text: string, top: number): RecommendItem[] {
  const lower = text.toLowerCase()
  const metas = selectableTemplates()
  const metaByKey = new Map(metas.map((m) => [m.key, m]))
  const scored: RecommendItem[] = []
  for (const [key, words] of Object.entries(KEYWORDS)) {
    const meta = metaByKey.get(key)
    if (!meta) continue
    let hits = 0
    for (const w of words) if (lower.includes(w.toLowerCase())) hits++
    if (hits > 0) scored.push({ key, name: meta.name, score: hits / Math.max(1, words.length) })
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return scored.slice(0, top)
}

/**
 * 推荐入口：embedding 优先、失败/未 ready 走 keyword fallback。
 * 空 text 由调用方（路由）先拒 400，本函数不再报错。
 */
export async function recommendTemplates(rawText: string, top = 3): Promise<RecommendResult> {
  const text = rawText.trim()
  if (!text) return { items: [], source: 'empty', ready: recommendReady() }
  if (vectors.size === 0 && !loading) {
    // 首次调用可能在启动 lazy refresh 之前；此处按需触发一次（不 await，不阻塞响应）
    void refreshTemplateVectors()
  }
  if (vectors.size > 0) {
    try {
      const qv = await embed(text)
      const scored: RecommendItem[] = []
      for (const v of vectors.values()) {
        scored.push({ key: v.key, name: v.name, score: cosine(qv, v.vector) })
      }
      scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
      return { items: scored.slice(0, top), source: 'embedding', ready: true }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      // 落到 keyword 分支
    }
  }
  const items = keywordMatch(text, top)
  return {
    items,
    source: items.length ? 'keyword' : 'empty',
    ready: false,
    error: lastError ?? undefined,
  }
}
