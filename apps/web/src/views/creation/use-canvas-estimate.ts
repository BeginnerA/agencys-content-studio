/** [M28] 创作画布：CanvasEstimate；依赖显式注入，原函数体保持不变。 */
import { ref } from 'vue'
import { creationApi } from '../../lib/api'
import type { PreviewCanvasResult } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'

type Dependencies = Pick<CanvasState, 'canvasId' | 'selectedIds' | 'toast'>

export function useCanvasEstimate(deps: Dependencies) {
  const { canvasId, selectedIds, toast } = deps

  // ===== [M18] 预估成本（批量面板 → 弹窗；零副作用） =====
  const showEstimate = ref(false)
  const estimateBusy = ref(false)
  const estimateResult = ref<PreviewCanvasResult | null>(null)
  /** [M18] 预估单位 / 生成类型文案（对齐 usage.ts UsageUnit 与 GEN_KINDS） */
  const UNIT_TEXT: Record<string, string> = { tokens_in: '输入 tokens', tokens_out: '输出 tokens', image: '张', second: '秒', char: '字符' }
  const GEN_KIND_TEXT: Record<string, string> = { image: '图片生成', video: '视频生成', audio: '音频生成', compose: '音视频合成', llm: '文本生成' }

  async function openEstimate(): Promise<void> {
    const cid = canvasId.value
    const ids = [...selectedIds.value]
    if (cid == null || !ids.length || estimateBusy.value) return
    estimateBusy.value = true
    try {
      estimateResult.value = await creationApi.runPreview(cid, ids)
      showEstimate.value = true
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      estimateBusy.value = false
    }
  }

  return {
    showEstimate,
    estimateBusy,
    estimateResult,
    UNIT_TEXT,
    GEN_KIND_TEXT,
    openEstimate,
  }
}

export type CanvasEstimate = ReturnType<typeof useCanvasEstimate>
