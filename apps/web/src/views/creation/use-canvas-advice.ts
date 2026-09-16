/** [M28 装配风格] [M23-D11] 创作画布：AI 编排建议（LLM 生成；仅展示 + 定位，不自动执行）。 */
import { ref } from 'vue'
import { ApiError, creationApi } from '../../lib/api'
import type { CanvasAdviceResult } from '../../lib/types'
import type { CanvasState } from './use-canvas-state'
import type { CanvasOverview } from './use-canvas-overview'

type Dependencies = Pick<CanvasState, 'canvasId'> & Pick<CanvasOverview, 'focusNode'>

export function useCanvasAdvice(deps: Dependencies) {
  const { canvasId, focusNode } = deps

  const showAdvice = ref(false)
  const adviceBusy = ref(false)
  const adviceError = ref('')
  const adviceResult = ref<CanvasAdviceResult | null>(null)

  /** 打开建议面板（每次点击都重新请求；显式单次调用，不缓存不轮询） */
  async function openAdvice(): Promise<void> {
    const id = canvasId.value
    if (id == null || adviceBusy.value) return
    showAdvice.value = true
    adviceBusy.value = true
    adviceError.value = ''
    try {
      adviceResult.value = await creationApi.advice(id)
    } catch (e) {
      adviceResult.value = null
      // llm_unavailable：引导去设置页配置供应商（其余错误原样透出）
      if (e instanceof ApiError && e.code === 'llm_unavailable') {
        adviceError.value = '未配置可用的 LLM 供应商：请到「设置 → 供应商」添加并启用后重试'
      } else {
        adviceError.value = e instanceof Error ? e.message : String(e)
      }
    } finally {
      adviceBusy.value = false
    }
  }

  /** 定位建议目标节点（关闭面板 → 选中 + 视口居中） */
  function locateAdvice(nodeId: number): void {
    showAdvice.value = false
    focusNode(nodeId)
  }

  return { showAdvice, adviceBusy, adviceError, adviceResult, openAdvice, locateAdvice }
}

export type CanvasAdvice = ReturnType<typeof useCanvasAdvice>
