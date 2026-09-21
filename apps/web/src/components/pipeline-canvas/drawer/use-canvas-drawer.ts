/**
 * [M28] 节点抽屉状态与操作（自 CanvasDrawer.vue 逐字迁移）
 * —— 装配约定：函数体逐字保留；props/emit 经参数注入；包裹层缩进 +2（机械转换）
 */
import { computed, nextTick, ref, watch } from 'vue'
import type {
  Asset,
  GenTask,
  RunCanvasNode,
  RunStep,
  TemplateCanvasNode,
} from '../../../lib/types'
import { assetApi, runApi, shotApi, taskApi } from '../../../lib/api'
import { confirmDialog } from '../../../lib/confirm'

export type DrawerSel =
  | { mode: 'run'; node: RunCanvasNode }
  | { mode: 'template'; node: TemplateCanvasNode }

export interface DrawerProps {
  runId: number | null
  sel: DrawerSel
  log: string
  projectId: number | null
}

export interface DrawerEmits {
  close: []
  refresh: []
  'open-canvas': [canvasId: number]
}

/** emit 签名（与 defineEmits<DrawerEmits>() 返回结构一致；供状态 composable 参数注入） */
export type DrawerEmitFn = {
  <K extends keyof DrawerEmits>(event: K, ...args: DrawerEmits[K]): void
}

export function useCanvasDrawer(props: DrawerProps, emit: DrawerEmitFn) {
  /** run / template 两态视图（互斥非空） */
  const rn = computed<RunCanvasNode | null>(() =>
    props.sel.mode === 'run' ? props.sel.node : null,
  )
  const tn = computed<TemplateCanvasNode | null>(() =>
    props.sel.mode === 'template' ? props.sel.node : null,
  )

  const notice = ref('')
  const opErr = ref('')

  // ===== ① 闸门（waiting_input 时内嵌 GateDialog，产物文本可审阅修改）=====
  const gateBusy = ref(false)
  const gateErr = ref('')
  const gateText = ref('')
  const gateTextName = ref('')

  const gateVisible = computed(() => {
    const n = rn.value
    return (
      !!n &&
      n.status === 'waiting_input' &&
      !!n.gate &&
      !!n.actions.gate &&
      (n.actions.gate.approve || n.actions.gate.reject)
    )
  })
  const gateSkipLabel = computed(() => {
    const n = rn.value
    return n && n.actions.gate?.skip
      ? (n.gate?.skipLabel ?? undefined)
      : undefined
  })

  async function loadGateArtifact(): Promise<void> {
    gateText.value = ''
    gateTextName.value = ''
    const n = rn.value
    if (!n || !n.gate || n.status !== 'waiting_input') return
    const assetId = n.assetIds[0]
    if (!assetId) return
    try {
      const { asset: a } = await assetApi.detail(assetId)
      if (
        a.kind === 'text' ||
        a.purpose === 'script' ||
        a.purpose === 'storyboard'
      ) {
        gateTextName.value = a.name
        const res = await fetch(a.urls.file)
        if (res.ok) gateText.value = await res.text()
      }
    } catch {
      // 产物不可读则只显示操作按钮
    }
  }

  async function onGateDecided(
    action: 'approve' | 'reject' | 'skip' | 'abort',
    payload: { note?: string; textOverride?: string },
  ): Promise<void> {
    const n = rn.value
    if (!n || props.runId == null) return
    gateBusy.value = true
    gateErr.value = ''
    try {
      const body: Record<string, unknown> = {
        step_key: n.key,
        decision: action,
      }
      if (payload.note) body.note = payload.note
      if (payload.textOverride) body.text_override = payload.textOverride
      await runApi.gate(props.runId, body)
      notice.value = '闸门决策已提交，正在对账…'
      emit('refresh')
    } catch (e) {
      gateErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      gateBusy.value = false
    }
  }

  // ===== ② 单步重跑 / 重新合成 =====
  const showRerun = ref(false)
  const recomposeBusy = ref(false)

  /** node → RunStep（RerunModal 按 step.id 过滤任务计数） */
  const rerunStep = computed<RunStep | null>(() => {
    const n = rn.value
    if (!n || n.stepId == null) return null
    return {
      id: n.stepId,
      seq: n.seq,
      stepKey: n.key,
      actionKey: n.action,
      title: n.title,
      status: n.status,
      attempts: n.attempts,
      input:
        n.input && typeof n.input === 'object' && !Array.isArray(n.input)
          ? (n.input as Record<string, unknown>)
          : null,
      output: null,
      error: n.error,
      startedAt: n.startedAt,
      completedAt: n.completedAt,
    }
  })

  function onRerunDone(res: { note: string }): void {
    showRerun.value = false
    notice.value = res.note || '已提交单步重跑'
    emit('refresh')
  }

  async function doRecompose(): Promise<void> {
    const n = rn.value
    if (!n || props.runId == null) return
    const ok = await confirmDialog({
      title: '重新合成',
      message: `将重置「${n.title}」的合成结果并重新执行（本地 ffmpeg 合成，零计费；镜头选择保留）。`,
      confirmText: '重新合成',
    })
    if (!ok) return
    recomposeBusy.value = true
    opErr.value = ''
    try {
      const res = await shotApi.recompose(props.runId, n.key)
      notice.value = res.note || '已提交重新合成'
      emit('refresh')
    } catch (e) {
      opErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      recomposeBusy.value = false
    }
  }

  // ===== ③ 子任务列表（run_id 拉取 → 按 stepId 前端过滤）=====
  const tasks = ref<GenTask[]>([])
  const tasksLoading = ref(false)
  const taskBusy = ref<number | null>(null)
  const taskErr = ref('')

  async function loadTasks(): Promise<void> {
    tasks.value = []
    taskErr.value = ''
    const n = rn.value
    if (!n || props.runId == null || n.stepId == null) return
    tasksLoading.value = true
    try {
      const r = await taskApi.list(`?run_id=${props.runId}`)
      tasks.value = r.items.filter((t) => t.stepId === n.stepId)
    } catch (e) {
      taskErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      tasksLoading.value = false
    }
  }

  async function retryTask(t: GenTask): Promise<void> {
    taskBusy.value = t.id
    taskErr.value = ''
    try {
      await taskApi.retry(t.id)
      notice.value = `任务 #${t.id} 已重新入队`
      await loadTasks()
      emit('refresh')
    } catch (e) {
      taskErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      taskBusy.value = null
    }
  }

  async function cancelTask(t: GenTask): Promise<void> {
    const ok = await confirmDialog({
      title: '取消任务',
      message: `确认取消任务 #${t.id}？该任务尚未完成，取消后可在重跑时重新执行。`,
      confirmText: '取消任务',
      danger: true,
    })
    if (!ok) return
    taskBusy.value = t.id
    taskErr.value = ''
    try {
      await taskApi.cancel(t.id)
      notice.value = `任务 #${t.id} 已取消`
      await loadTasks()
      emit('refresh')
    } catch (e) {
      taskErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      taskBusy.value = null
    }
  }

  // ===== ④ 产物缩略（assetIds → detail 并发；点击自持预览器）=====
  const ASSET_CAP = 24
  const assets = ref<Asset[]>([])
  const assetsLoading = ref(false)
  const previewIdx = ref<number | null>(null)

  async function loadAssets(): Promise<void> {
    assets.value = []
    const n = rn.value
    if (!n || !n.assetIds.length) return
    assetsLoading.value = true
    try {
      const settled = await Promise.allSettled(
        n.assetIds
          .slice(0, ASSET_CAP)
          .map((id) => assetApi.detail(id).then((r) => r.asset)),
      )
      assets.value = settled
        .filter(
          (r): r is PromiseFulfilledResult<Asset> => r.status === 'fulfilled',
        )
        .map((r) => r.value)
    } finally {
      assetsLoading.value = false
    }
  }

  function onAssetChanged(updated: Asset): void {
    assets.value = assets.value.map((a) => (a.id === updated.id ? updated : a))
  }

  // ===== ⑤ 输入区（引用清单 + step.input 快照）=====
  const REF_KIND_TEXT: Record<string, string> = {
    input: '启动输入',
    step: '上游产物',
    'assets-purpose': '资产库',
  }
  const refs = computed(() => props.sel.node.inputsRefs ?? [])
  const inputJson = computed<string>(() => {
    const n = rn.value
    if (!n || n.input == null) return ''
    if (typeof n.input === 'string') return n.input
    try {
      return JSON.stringify(n.input, null, 2)
    } catch {
      return String(n.input)
    }
  })

  // ===== ⑥ 模板态文案 =====
  const depText = computed(() => {
    const n = tn.value
    if (!n) return '—'
    if (n.after === undefined) return '缺省：前一步'
    return n.after.length ? n.after.join('、') : '无（after: []）'
  })
  const condText = computed(() => {
    const n = tn.value
    if (!n) return '—'
    if (n.when) return Array.isArray(n.when) ? n.when.join(' ∧ ') : n.when
    if (n.whenAny?.length) return `任一：${n.whenAny.join(' ∨ ')}`
    return '—'
  })
  const batchText = computed(() => {
    const b = tn.value?.batch
    if (!b) return '—'
    let s = b.field
    if (b.maxConcurrent != null) s += ` · 并发 ${b.maxConcurrent}`
    if (b.retry != null) s += ` · 重试 ${b.retry}`
    return s
  })

  // ===== ⑦ 日志（父级已按 [stepKey] 过滤节流；此处按当前节点二次过滤）=====
  const logEl = ref<HTMLElement | null>(null)
  const logLines = computed(() => {
    const key = props.sel.node.key
    return props.log
      .split('\n')
      .filter((l) => l.includes(`[${key}]`))
      .slice(-200)
  })
  const logText = computed(() => logLines.value.join('\n'))

  watch(
    () => props.log,
    () => {
      const el = logEl.value
      if (!el) return
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      if (nearBottom)
        void nextTick(() => {
          el.scrollTop = el.scrollHeight
        })
    },
  )

  // ===== ⑧ [M16] 送入创作画布（步骤产物 → 目标画布素材节点）=====
  const showSend = ref(false)
  const sendItems = computed<Array<{ id: number; name: string }>>(() => {
    const n = rn.value
    if (!n) return []
    const byId = new Map(assets.value.map((a) => [a.id, a]))
    return n.assetIds.map((id) => ({
      id,
      name: byId.get(id)?.name ?? `产物 #${id}`,
    }))
  })
  function onSendDone(canvasId: number): void {
    showSend.value = false
    notice.value = `已送入创作画布 #${canvasId}`
    emit('open-canvas', canvasId)
  }

  // ===== 重载：节点切换 / 状态与任务计数变化 / 产物变化 =====
  watch(
    () => `${props.sel.mode}:${props.sel.node.key}`,
    () => {
      notice.value = ''
      opErr.value = ''
      void loadGateArtifact()
      void loadTasks()
      void loadAssets()
    },
    { immediate: true },
  )
  watch(
    () => {
      const n = rn.value
      return n
        ? `${n.status}|${n.tasks.total}|${n.tasks.succeeded}|${n.tasks.failed}|${n.tasks.cancelled}`
        : ''
    },
    () => {
      void loadGateArtifact()
      void loadTasks()
    },
  )
  watch(
    () => (rn.value ? rn.value.assetIds.join(',') : ''),
    () => void loadAssets(),
  )

  return {
    rn,
    tn,
    notice,
    opErr,
    gateBusy,
    gateErr,
    gateText,
    gateTextName,
    gateVisible,
    gateSkipLabel,
    onGateDecided,
    showRerun,
    recomposeBusy,
    rerunStep,
    onRerunDone,
    doRecompose,
    tasks,
    tasksLoading,
    taskBusy,
    taskErr,
    retryTask,
    cancelTask,
    assets,
    assetsLoading,
    previewIdx,
    onAssetChanged,
    REF_KIND_TEXT,
    refs,
    inputJson,
    depText,
    condText,
    batchText,
    logEl,
    logLines,
    logText,
    showSend,
    sendItems,
    onSendDone,
  }
}
