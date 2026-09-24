/** 创作画布：CanvasExport；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi } from '../../lib/api'
import type { CanvasExportResult, TemplateValidation } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasCommands } from './use-canvas-commands'
import type { CanvasDocument } from './use-canvas-doc'

type Dependencies = Pick<
  CanvasState,
  'canvasId' | 'doc' | 'toast' | 'boardRef'
> &
  Pick<CanvasCommands, 'addNodesCommand'> &
  Pick<CanvasDocument, 'loadDoc'>

export function useCanvasExport(deps: Dependencies) {
  const { canvasId, doc, toast, boardRef, addNodesCommand, loadDoc } = deps

  // ===== 导出 zip（打包为 archive 资产 → 下载复用资产文件端点） =====
  const exportBusy = ref(false)
  const showExport = ref(false)
  const exportResult = ref<CanvasExportResult | null>(null)

  async function onExportZip(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    exportBusy.value = true
    try {
      exportResult.value = await creationApi.exportZip(cid)
      showExport.value = true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      exportBusy.value = false
    }
  }

  // ===== 布局图导出（服务端 SVG 落库 + 前端下载/光栅化；零新依赖） =====
  const imageBusy = ref(false)

  /** Blob 触发浏览器下载（临时 a[download]；OBJECT URL 延迟回收） */
  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  /** SVG 文本 → PNG Blob（浏览器原生 Image + canvas 2x 光栅化） */
  async function svgToPngBlob(svgText: string, scale = 2): Promise<Blob> {
    const url = URL.createObjectURL(
      new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }),
    )
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('SVG 光栅化失败（图片加载错误）'))
        img.src = url
      })
      const w = img.naturalWidth || img.width || 1200
      const h = img.naturalHeight || img.height || 800
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d 上下文不可用')
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))),
          'image/png',
        )
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** 当前画布名（文件名用；缺省兜底 canvas-{id}） */
  function canvasFileName(cid: number): string {
    return doc.value?.canvas.name?.trim() || `canvas-${cid}`
  }

  /** 导出 SVG（服务端落资产库 + 前端文本直下） */
  async function onExportSvg(): Promise<void> {
    const cid = canvasId.value
    if (cid == null || imageBusy.value) return
    imageBusy.value = true
    try {
      const r = await creationApi.exportImage(cid)
      const name = canvasFileName(cid)
      downloadBlob(
        new Blob([r.svg], { type: 'image/svg+xml;charset=utf-8' }),
        `${name}.svg`,
      )
      toast(`已导出 SVG（资产 #${r.assetId}）：${name}.svg`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      imageBusy.value = false
    }
  }

  /** 导出 PNG（复用服务端 SVG → 前端 2x 光栅化下载） */
  async function onExportPng(): Promise<void> {
    const cid = canvasId.value
    if (cid == null || imageBusy.value) return
    imageBusy.value = true
    try {
      const r = await creationApi.exportImage(cid)
      const name = canvasFileName(cid)
      const blob = await svgToPngBlob(r.svg)
      downloadBlob(blob, `${name}.png`)
      toast(`已导出 PNG（2x 光栅化）：${name}.png`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      imageBusy.value = false
    }
  }

  // ===== 联动②：导出模板草案 v2 =====
  const showDraft = ref(false)
  const draftBusy = ref(false)
  const draftTryBusy = ref(false)
  const draftYaml = ref('')
  const draftValidation = ref<TemplateValidation | null>(null)
  const draftLossy = ref<string[]>([])

  async function openDraft(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    draftBusy.value = true
    try {
      const r = await creationApi.templateDraft(cid)
      draftYaml.value = r.yaml
      draftValidation.value = r.validation
      draftLossy.value = r.lossy ?? []
      showDraft.value = true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      draftBusy.value = false
    }
  }
  async function copyDraft(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draftYaml.value)
      toast('YAML 已复制到剪贴板')
    } catch {
      toast('复制失败（剪贴板不可用，可手动全选复制）')
    }
  }

  /** 草案弹窗内「试跑」：建 queued run + 视口中心自动创建 run 节点 */
  async function tryRunFromDraft(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    draftTryBusy.value = true
    try {
      const r = await creationApi.templateTry(cid)
      const at = boardRef.value?.centerWorld() ?? { x: 160, y: 120 }
      try {
        await addNodesCommand(
          cid,
          [{ kind: 'run', runId: r.runId, x: at.x, y: at.y }],
          '试跑新建运行节点',
        )
        await loadDoc(true)
      } catch (e) {
        toast(
          `run 已建但节点创建失败：${e instanceof Error ? e.message : String(e)}`,
        )
      }
      toast(
        `已试跑→ 模板「${r.templateKey}」· run #${r.runId}（queued）${r.lossy.length ? ` · ${r.lossy.length} 项降级` : ''}`,
      )
      showDraft.value = false
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      draftTryBusy.value = false
    }
  }

  return {
    exportBusy,
    showExport,
    exportResult,
    onExportZip,
    imageBusy,
    onExportSvg,
    onExportPng,
    showDraft,
    draftBusy,
    draftTryBusy,
    draftYaml,
    draftValidation,
    draftLossy,
    openDraft,
    copyDraft,
    tryRunFromDraft,
  }
}

export type CanvasExport = ReturnType<typeof useCanvasExport>
