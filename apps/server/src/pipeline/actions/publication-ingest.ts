import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../db'
import { assets, pipelineRuns, publications, type Publication } from '../../db/schema'
import { readTextAsset, writeTextAsset } from '../../services/storage'
import type { StepContext } from '../context'
import type { StepResult } from '../types'

/**
 * publication_ingest：发布记录入库（复盘回灌专用）。
 * 直接读取 run 启动时勾选的发布记录（input 引用 publication id 列表），
 * 装配为「平台数据复盘」文档：指标表 + 创作链路（关联来源 run 的模板/启动输入）
 * + 发布正文摘要（从来源 run 的发布稿文本资产提取，让复盘能看到「到底发了什么」）。
 * 取代「导出 CSV → 手动上传」的绕路，让复盘对齐整条创作闭环——
 * 产物为一个文本资产（下游 review 步骤按 steps.<key>.asset 消费）。
 */

/** 单条发布正文注入复盘文档的最大字符数（避免淹没指标分析） */
const CONTENT_CLIP = 1200

/** 从发布稿正文提炼一个可读标题：首个 Markdown 一级标题 > 首个非空行 > 空 */
function deriveTitleFromContent(text: string): string {
  const heading = text.match(/^#{1,3}\s+(.+?)\s*#*$/m)?.[1]
  if (heading?.trim()) return heading.trim().slice(0, 60)
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
  return line ? line.slice(0, 60) : ''
}

/** 正文截断：超限保留前 max 字并标注总长 */
function clip(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}…（正文已截断，共 ${t.length} 字）` : t
}

const PLATFORM_TEXT: Record<string, string> = {
  douyin: '抖音',
  wechat_channels: '视频号',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  other: '其他',
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtDate(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Markdown 表格单元格转义：竖线/换行会破坏表格 */
function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function safeMetrics(raw: string | null): { views: number; likes: number; comments: number; favorites: number; shares: number } {
  const zero = { views: 0, likes: 0, comments: 0, favorites: 0, shares: 0 }
  if (!raw) return zero
  try {
    const m = JSON.parse(raw) as Record<string, unknown>
    const num = (k: string): number => {
      const n = Number(m[k] ?? 0)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    }
    return { views: num('views'), likes: num('likes'), comments: num('comments'), favorites: num('favorites'), shares: num('shares') }
  } catch {
    return zero
  }
}

/** 从来源 run 的启动输入快照中提炼可读摘要（仅标量、跳过内部键与 id 数组），供 AI 回看创作意图 */
function briefInputSummary(inputJson: string | null): string {
  if (!inputJson) return ''
  try {
    const obj = JSON.parse(inputJson) as Record<string, unknown>
    const parts: string[] = []
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue
      if (typeof v === 'string' && v.trim()) parts.push(`${k}：${esc(v).slice(0, 80)}`)
      else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}：${String(v)}`)
      if (parts.length >= 6) break
    }
    return parts.join('；')
  } catch {
    return ''
  }
}

export async function publicationIngest(ctx: StepContext): Promise<StepResult> {
  // 兼容 pubs / data 两种引用键（模板以 pubs 声明）
  const raw = ctx.input['pubs'] ?? ctx.input['data']
  const ids = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length === 0) throw new Error('publication_ingest：未选择要复盘的发布记录')

  const rows = await db
    .select()
    .from(publications)
    .where(and(inArray(publications.id, ids), eq(publications.projectId, ctx.run.projectId)))
  if (rows.length === 0) throw new Error('publication_ingest：所选发布记录不存在或不属于本项目')

  // 保持用户选择顺序，过滤越权/已删条目
  const byId = new Map(rows.map((r) => [r.id, r]))
  const ordered: Publication[] = ids.map((id) => byId.get(id)).filter((r): r is Publication => Boolean(r))

  // 关联创作链路：抓取来源 run 的模板 key 与启动输入（可空）
  const runIds = [...new Set(ordered.map((r) => r.runId).filter((n): n is number => typeof n === 'number' && n > 0))]
  const runMap = new Map<number, { templateKey: string; input: string | null }>()
  if (runIds.length > 0) {
    const runs = await db
      .select({ id: pipelineRuns.id, templateKey: pipelineRuns.templateKey, input: pipelineRuns.input })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.id, runIds))
    for (const rn of runs) runMap.set(rn.id, { templateKey: rn.templateKey, input: rn.input })
  }

  // [整改] 抓取发布正文：来源 run 的发布稿文本资产（publish 稿 > 其它 export > script 主稿）
  const contentByRun = new Map<number, { name: string; title: string; body: string }>()
  if (runIds.length > 0) {
    const candRows = await db
      .select({ id: assets.id, runId: assets.runId, name: assets.name, purpose: assets.purpose, relPath: assets.relPath })
      .from(assets)
      .where(
        and(
          inArray(assets.runId, runIds),
          eq(assets.kind, 'text'),
          inArray(assets.purpose, ['export', 'script']),
          isNull(assets.deletedAt),
        ),
      )
    const scoreOf = (a: { name: string; purpose: string | null }): number =>
      (/publish/i.test(a.name) ? 4 : 0) + (a.purpose === 'export' ? 2 : 0) + (a.purpose === 'script' ? 1 : 0)
    const bestByRun = new Map<number, (typeof candRows)[number]>()
    for (const a of candRows) {
      if (a.runId == null || !a.relPath) continue
      const cur = bestByRun.get(a.runId)
      const better = !cur || scoreOf(a) > scoreOf(cur) || (scoreOf(a) === scoreOf(cur) && a.id > cur.id)
      if (better) bestByRun.set(a.runId, a)
    }
    for (const [rid, a] of bestByRun) {
      try {
        const full = await readTextAsset(a.id)
        contentByRun.set(rid, { name: a.name, title: deriveTitleFromContent(full), body: clip(full, CONTENT_CLIP) })
      } catch {
        /* 读取失败跳过，不阻塞复盘入库 */
      }
    }
  }

  /** 发布记录展示标题：登记标题 > 来源发布稿首行/一级标题 > (无标题) */
  const titleOf = (r: Publication): string =>
    r.title?.trim() || (r.runId ? contentByRun.get(r.runId)?.title : '') || '(无标题)'

  const lines: string[] = []
  lines.push('# 平台发布数据（复盘回灌·直接勾选发布记录）')
  lines.push('')
  lines.push(`- 数据源：本项目发布记录 ${ordered.length} 条（启动复盘时勾选，未走 CSV 导入）`)
  lines.push('')
  lines.push('| 标题 | 平台 | 发布时间 | 曝光 | 点赞 | 评论 | 收藏 | 转发 | 互动率 | A/B组 | 创作来源 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of ordered) {
    const m = safeMetrics(r.metrics)
    const inter = m.views > 0 ? ((m.likes + m.comments + m.favorites + m.shares) / m.views).toFixed(3) : ''
    const src =
      r.runId && runMap.has(r.runId)
        ? `run#${r.runId}（${runMap.get(r.runId)!.templateKey}）`
        : r.runId
          ? `run#${r.runId}`
          : '外部登记'
    lines.push(
      `| ${esc(titleOf(r))} | ${PLATFORM_TEXT[r.platform] ?? r.platform} | ${fmtDate(r.publishedAt)} | ${m.views} | ${m.likes} | ${m.comments} | ${m.favorites} | ${m.shares} | ${inter} | ${esc(r.abGroup || '')} | ${src} |`,
    )
  }

  // 创作链路明细：让复盘结论/回灌建议可回溯到当初的选题与脚本
  const withRun = ordered.filter((r) => r.runId && runMap.has(r.runId))
  if (withRun.length > 0) {
    lines.push('')
    lines.push('## 创作链路（发布记录 ← 生成它的流水线 run）')
    for (const r of withRun) {
      const rn = runMap.get(r.runId!)!
      lines.push(`- 「${esc(titleOf(r))}」← run#${r.runId}（${rn.templateKey}）`)
      const topic = briefInputSummary(rn.input)
      if (topic) lines.push(`  · 启动输入：${topic}`)
      if (r.note) lines.push(`  · 发布备注：${esc(r.note)}`)
    }
  }

  // [整改] 发布正文节：让复盘 AI 看到「实际发了什么内容」，标题模式/内容维度分析才有效
  const contentRows = ordered
    .map((r) => ({ r, c: r.runId ? contentByRun.get(r.runId) : undefined }))
    .filter((x): x is { r: Publication; c: { name: string; title: string; body: string } } => Boolean(x.c))
  if (contentRows.length > 0) {
    lines.push('')
    lines.push('## 发布正文（来源 run 的发布稿，供标题模式与内容维度复盘）')
    for (const { r, c } of contentRows) {
      lines.push('')
      lines.push(`### ${esc(titleOf(r))}`)
      lines.push(`> 来源发布稿：${esc(c.name)}（run#${r.runId}）`)
      lines.push('')
      lines.push(c.body)
    }
  }

  const asset = await writeTextAsset(ctx.run.projectId, {
    name: 'review-input-publications.md',
    content: lines.join('\n'),
    purpose: 'source',
    stepId: ctx.step.id,
    runId: ctx.run.id,
    tags: ['review-input'],
  })
  ctx.log(
    `发布记录已入库：${ordered.length} 条（${withRun.length} 条带创作链路，${contentRows.length} 条带发布正文）→ asset#${asset.id}（${asset.fileSize} 字节）`,
  )
  return { assetIds: [asset.id] }
}
