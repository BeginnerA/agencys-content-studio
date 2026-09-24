/**
 * 自动连载·增量导入（spec §2.7）：向在跑/已跑 run 的章节链追加新章，不级联重跑。
 * 流程：新文件走 G1 导入（docx/epub/txt/md → source 资产）→ 逐源独立切分（复用该 run
 * split 步骤的 regex_used）→「章题 + 归一化首行哈希」与既有章节幂等比对 → 新章续编 index
 * 落库（挂同一 step/run）→ manifest 重写（appended_at 追加记录，经 G2 受控写通道）。
 * 引擎边界红线：只写资产、零触碰 run/step 状态机——事件链续跑走既有单步重跑。
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { pipelineRuns, pipelineSteps } from '../db/schema'
import { splitChapters, type ChapterSlice } from '../pipeline/actions/text-split'
import { updateAssetContent } from './asset-content'
import { importFiles, readTextAsset, sha256Hex, writeTextAsset } from './storage'

export class NovelAppendError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NovelAppendError'
  }
}

export interface NovelAppendResult {
  added: number
  skipped: number
  total: number
  new_asset_ids: number[]
}

interface ManifestChapter {
  index?: unknown
  reel?: unknown
  title?: unknown
  name?: unknown
  asset_id?: unknown
  chars?: unknown
  source_book?: unknown
}
interface ManifestDoc {
  regex_used?: unknown
  total?: unknown
  selected?: unknown
  chapters?: ManifestChapter[]
  appended_at?: unknown
  [k: string]: unknown
}

/** 幂等键：章题归一 + 首个非空行归一后 sha256 前 16 位（章头行形态变化容忍空白/全半角外噪声） */
function chapterKey(title: string, content: string): string {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const firstLine = content.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return `${norm(title)}|${sha256Hex(new TextEncoder().encode(norm(firstLine))).slice(0, 16)}`
}

export async function appendNovelChapters(
  projectId: number,
  runId: number,
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<NovelAppendResult> {
  // —— 1. run / split 步骤 / manifest 定位 ——
  const runRows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run || run.projectId !== projectId) throw new NovelAppendError('not_found', `run ${runId} 不存在或不属于项目 ${projectId}`)
  const stepRows = await db
    .select()
    .from(pipelineSteps)
    .where(and(eq(pipelineSteps.runId, runId), eq(pipelineSteps.actionKey, 'text_split')))
    .limit(1)
  const splitStep = stepRows[0]
  if (!splitStep) throw new NovelAppendError('no_split', '该 run 无章节切分步骤（请先跑完 novel-adapt 切分链）')
  let assetIds: number[] = []
  try {
    const out = JSON.parse(splitStep.output ?? '{}') as { asset_ids?: unknown }
    if (Array.isArray(out.asset_ids)) assetIds = out.asset_ids.filter((n): n is number => typeof n === 'number')
  } catch {
    /* 脏 output → 下方统一报 no_manifest */
  }
  if (assetIds.length === 0) throw new NovelAppendError('no_manifest', '切分步骤无产物（manifest 未生成）')
  const manifestId = assetIds[0]!
  let manifest: ManifestDoc
  try {
    manifest = JSON.parse(await readTextAsset(manifestId)) as ManifestDoc
  } catch {
    throw new NovelAppendError('bad_manifest', '章节 manifest 读取/解析失败')
  }
  const existing = Array.isArray(manifest.chapters) ? manifest.chapters : []

  // —— 2. 既有章节幂等键集合（章题 + 归一化首行哈希） ——
  const keys = new Set<string>()
  let maxIndex = 0
  for (const ch of existing) {
    const aid = typeof ch.asset_id === 'number' ? ch.asset_id : 0
    if (typeof ch.index === 'number' && ch.index > maxIndex) maxIndex = ch.index
    if (!aid) continue
    try {
      keys.add(chapterKey(typeof ch.title === 'string' ? ch.title : '', await readTextAsset(aid)))
    } catch {
      /* 章文件缺失 → 该键不参与去重（新章若同题可再入，宁漏不误拦） */
    }
  }

  // —— 3. 新文件导入（G1 单点：docx/epub → md）+ 正则复用 ——
  const imported = await importFiles(projectId, files, { purpose: 'source' })
  const regex =
    typeof manifest.regex_used === 'string' && manifest.regex_used
      ? (() => {
          try {
            return new RegExp(manifest.regex_used as string, 'gm')
          } catch {
            return null // 脏正则 → 回落默认链
          }
        })()
      : null

  // —— 4. 逐源切分 + 幂等过滤 + 续编落库 ——
  let added = 0
  let skipped = 0
  const newAssetIds: number[] = []
  const perFile: Array<{ file: string; added: number; skipped: number }> = []
  for (const a of imported) {
    if (a.kind !== 'text' || !a.relPath) {
      skipped += 1
      continue
    }
    const content = await readTextAsset(a.id)
    const { chapters } = splitChapters(content, regex)
    let fAdd = 0
    let fSkip = 0
    for (const ch of chapters) {
      const key = chapterKey(ch.title, ch.content)
      if (keys.has(key)) {
        fSkip++
        continue
      }
      keys.add(key)
      const next: ChapterSlice = { index: ++maxIndex, title: ch.title, reel: ch.reel, content: ch.content, source_book: a.name }
      const asset = await writeTextAsset(projectId, {
        name: `第${String(next.index).padStart(3, '0')}章-${next.title || '续'}.md`,
        content: next.content,
        purpose: 'chapters',
        stepId: splitStep.id,
        runId,
        tags: ['chapter'],
        params: { index: next.index, reel: next.reel, chars: next.content.length, source_book: next.source_book, appended_at: Date.now() },
      })
      manifest.chapters = existing
      existing.push({
        index: next.index,
        reel: next.reel,
        title: next.title,
        name: asset.name,
        asset_id: asset.id,
        chars: next.content.length,
        source_book: next.source_book,
      })
      newAssetIds.push(asset.id)
      fAdd++
    }
    added += fAdd
    skipped += fSkip
    perFile.push({ file: a.name, added: fAdd, skipped: fSkip })
  }

  // —— 5. manifest 重写（仅当有新增；经 G2 受控写通道原子覆盖 + content_edits 留痕） ——
  if (added > 0) {
    manifest.total = (typeof manifest.total === 'number' ? manifest.total : existing.length - added) + added
    manifest.selected = (typeof manifest.selected === 'number' ? manifest.selected : existing.length - added) + added
    const log = Array.isArray(manifest.appended_at) ? (manifest.appended_at as unknown[]) : []
    log.push({ at: Date.now(), files: perFile })
    manifest.appended_at = log
    await updateAssetContent(manifestId, JSON.stringify(manifest, null, 2))
  }

  return { added, skipped, total: existing.length, new_asset_ids: newAssetIds }
}
