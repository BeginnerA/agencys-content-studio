/**
 * 平台数据文件导入弹层状态机（自 PublicationPanel.vue 拆出，行为零变更；M67 三步弹层 + ≤800 行红线拆分）
 * 持有导入三步（解析 → 列映射 → 预览确认）的全部状态与逻辑；
 * projectId 为父子共享真源由父级传入 Ref；导入成功后经 onImported 回调触发父级刷新。
 */
import { computed, ref, type Ref } from 'vue'
import { ApiError, publicationApi } from '../../lib/api'
import type { ImportPreview, ImportResult } from '../../lib/types'
import { fmtQty } from '../../lib/format'

export function usePublicationImport(opts: {
  projectId: Ref<number | ''>
  onImported: () => Promise<void> | void
}) {
  const { projectId, onImported } = opts

  const MAPPING_FIELDS = [
    { key: 'title', label: '标题' },
    { key: 'url', label: '链接 URL' },
    { key: 'publishedAt', label: '发布时间' },
    { key: 'views', label: '播放/曝光' },
    { key: 'likes', label: '点赞' },
    { key: 'comments', label: '评论' },
    { key: 'favorites', label: '收藏' },
    { key: 'shares', label: '转发/分享' },
    { key: 'abGroup', label: 'A/B 组' },
  ] as const

  const showImport = ref(false)
  const importStep = ref<1 | 3>(1)
  const importFile = ref<File | null>(null)
  const importPlatform = ref('douyin')
  const importMapping = ref<Record<string, number | ''>>({})
  const importPreview = ref<ImportPreview | null>(null)
  const importResult = ref('')
  const importErr = ref('')
  const importBusy = ref(false)
  const importPresets = ref<
    Record<string, { platform: string; mapping: Record<string, number> }>
  >({})
  const presetName = ref('')
  const importColumns = computed(() => importPreview.value?.columns ?? [])
  const mappedCount = computed(
    () => Object.values(importMapping.value).filter((v) => v !== '').length,
  )

  function openImport(): void {
    showImport.value = true
    importStep.value = 1
    importFile.value = null
    importPlatform.value = 'douyin'
    importMapping.value = {}
    importPreview.value = null
    importResult.value = ''
    importErr.value = ''
    presetName.value = ''
    publicationApi
      .importPresets()
      .then((r) => {
        importPresets.value = r.presets
      })
      .catch(() => {
        /* 预设拉取失败不阻断 */
      })
  }

  function onFilePick(e: Event): void {
    importFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
    importPreview.value = null
    importStep.value = 1
  }

  /** 「返回调整」：预览确认回第 1 步（模板内联多语句对 maybe-ref 绑定不可解析，收敛为显式函数） */
  function backToEdit(): void {
    importStep.value = 1
    importPreview.value = null
  }

  function compactMapping(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(importMapping.value)) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  }

  function applyPreset(name: string): void {
    const p = importPresets.value[name]
    if (!p) return
    importPlatform.value = p.platform
    importMapping.value = { ...p.mapping }
  }

  async function runParse(): Promise<void> {
    if (!importFile.value) return
    importBusy.value = true
    importErr.value = ''
    try {
      importPreview.value = (await publicationApi.importFile(importFile.value, {
        projectId: Number(projectId.value),
        platform: importPlatform.value,
        mapping: {},
        dryRun: true,
      })) as ImportPreview
      importStep.value = 3
    } catch (e) {
      importErr.value = e instanceof ApiError ? e.message : String(e)
    } finally {
      importBusy.value = false
    }
  }

  async function runPreview(): Promise<void> {
    if (!importFile.value) return
    importBusy.value = true
    importErr.value = ''
    try {
      const r = await publicationApi.importFile(importFile.value, {
        projectId: Number(projectId.value),
        platform: importPlatform.value,
        mapping: compactMapping(),
        dryRun: true,
      })
      importPreview.value = r as ImportPreview
      importStep.value = 3
    } catch (e) {
      importErr.value = e instanceof ApiError ? e.message : String(e)
    } finally {
      importBusy.value = false
    }
  }

  async function savePreset(): Promise<void> {
    const name = presetName.value.trim()
    if (!name) return
    importErr.value = ''
    try {
      await publicationApi.saveImportPreset({
        name,
        platform: importPlatform.value,
        mapping: compactMapping(),
      })
      importPresets.value = (await publicationApi.importPresets()).presets
    } catch (e) {
      importErr.value = e instanceof ApiError ? e.message : String(e)
    }
  }

  async function confirmImport(): Promise<void> {
    if (!importFile.value) return
    importBusy.value = true
    importErr.value = ''
    try {
      const r = await publicationApi.importFile(importFile.value, {
        projectId: Number(projectId.value),
        platform: importPlatform.value,
        mapping: compactMapping(),
        dryRun: false,
        preset: presetName.value.trim() || undefined,
      })
      const done = r as ImportResult
      importResult.value = `导入完成：新建 ${done.created} 条、更新 ${done.updated} 条`
      for (const w of done.warnings) importResult.value += `\n⚠ ${w}`
      await onImported()
    } catch (e) {
      importErr.value = e instanceof ApiError ? e.message : String(e)
    } finally {
      importBusy.value = false
    }
  }

  /** 示例行（服务端 AssembledRow，前端宽化为 Record）→ 紧凑单行文本 */
  function sampleRowText(r: Record<string, unknown>): string {
    const m = (r.metrics ?? {}) as Record<string, number>
    const parts: string[] = [
      `行${String(r.rowIndex)}`,
      String(r.title ?? '') || '—',
    ]
    if (typeof r.url === 'string' && r.url) parts.push(r.url)
    if (typeof r.abGroup === 'string' && r.abGroup)
      parts.push(`A/B ${r.abGroup}`)
    parts.push(
      typeof r.publishedAt === 'number'
        ? new Date(r.publishedAt).toLocaleDateString()
        : '无日期',
      `播放 ${fmtQty(m.views ?? 0)} · 赞 ${fmtQty(m.likes ?? 0)} · 评 ${fmtQty(m.comments ?? 0)} · 藏 ${fmtQty(m.favorites ?? 0)} · 转 ${fmtQty(m.shares ?? 0)}`,
    )
    return parts.join(' · ')
  }

  return {
    MAPPING_FIELDS,
    showImport,
    importStep,
    importFile,
    importPlatform,
    importMapping,
    importPreview,
    importResult,
    importErr,
    importBusy,
    importPresets,
    presetName,
    importColumns,
    mappedCount,
    openImport,
    onFilePick,
    backToEdit,
    applyPreset,
    runParse,
    runPreview,
    savePreset,
    confirmImport,
    sampleRowText,
  }
}
