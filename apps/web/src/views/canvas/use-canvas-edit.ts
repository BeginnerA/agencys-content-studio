/**
 * [M23] 画布内编辑（spec §2.5；E3/E4）——模板态的本地草稿层
 * - overrides：Record<stepKey, { title?, texts? }>，结构对齐 P3 template-edit 的 edits.steps[]
 * - edgeOps：Record<toKey, { added, removed }>（added/removed 互斥——撤销即抵消，buildEdits 最小化）
 * - 边语义镜像服务端单一真源：基础 after = 显式 / 缺省前一步（materializeAfter）；when 表达式隐含
 *   引用恒存在（不可删；连已存在边静默忽略）——与 dag.stepDepEdges 首见来源优先一致
 * - titleOf：画布节点标题 overlay（编辑即时生效）；nodeState：抽屉编辑区逐字段视图
 * - 纯本地：不改动模板文件、不发请求；buildEdits 产出落盘补丁，validateLocal 落盘前预检
 */
import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import type {
  CanvasEdge,
  EditNodeState,
  StepOverride,
  TemplateCanvas,
  TemplateCanvasNode,
  TemplateEditStep,
  TemplateEdits,
} from '../../lib/types'

export function useCanvasEdit(tplCanvas: Ref<TemplateCanvas | null>) {
  const editMode = ref(false)
  const overrides = ref<Record<string, StepOverride>>({})
  /** [M23-E4] 边操作（按目标步骤聚合；added/removed 互斥——撤销即抵消，edits 最小化） */
  const edgeOps = ref<Record<string, { added: string[]; removed: string[] }>>(
    {},
  )

  /** 是否有任何草稿改动（步骤覆盖 ∨ 边操作） */
  const dirty = computed(
    () =>
      Object.keys(overrides.value).length > 0 ||
      Object.keys(edgeOps.value).length > 0,
  )
  /** 受影响步骤数（标题/文本/边变更键并集） */
  const overriddenCount = computed(() => {
    const keys = new Set(Object.keys(overrides.value))
    for (const k of Object.keys(edgeOps.value)) keys.add(k)
    return keys.size
  })

  function baseNode(key: string): TemplateCanvasNode | null {
    return tplCanvas.value?.nodes.find((n) => n.key === key) ?? null
  }

  // ===== [M23-E4] 边操作层（镜像服务端 dag.stepDepEdges / template-edit 物化语义） =====

  /** 基础 after 物化（镜像 template-edit.materializeAfter）：显式 → 拷贝；缺省 → 前一步；首步 → [] */
  function baseAfterList(node: TemplateCanvasNode): string[] {
    if (node.after !== undefined) return [...node.after]
    const prev = tplCanvas.value?.nodes.find((n) => n.seq === node.seq - 1)
    return prev ? [prev.key] : []
  }

  /** when 表达式隐含步骤引用（镜像 dag.whenExprs + refs.parseWhenExpr 的 steps.x.count 正则） */
  const WHEN_STEP_RE = /^steps\.([\w-]+)\.count\s*(==|!=|>=|<=|>|<)\s*(\d+)$/
  function whenStepRefs(node: TemplateCanvasNode): string[] {
    const raw: string[] = []
    const add = (v: string | string[] | undefined): void => {
      if (v) raw.push(...(Array.isArray(v) ? v : [v]))
    }
    add(node.when)
    add(node.whenAny)
    add(node.gate?.when)
    const out: string[] = []
    for (const expr of raw) {
      const m = WHEN_STEP_RE.exec(expr.trim())
      if (m && !out.includes(m[1]!)) out.push(m[1]!)
    }
    return out
  }

  /** 当前有效 after（基础 ± 边操作） */
  function effectiveAfterList(node: TemplateCanvasNode): string[] {
    const ops = edgeOps.value[node.key]
    const base = baseAfterList(node)
    if (!ops) return base
    const out = base.filter((k) => !ops.removed.includes(k))
    for (const k of ops.added) if (!out.includes(k)) out.push(k)
    return out
  }

  /** 全视图边集（基础边 − 移除 + 追加；data 边透传）——Board 渲染与删除判定消费者 */
  function edgesOf(baseEdges: CanvasEdge[]): CanvasEdge[] {
    const out: CanvasEdge[] = []
    for (const e of baseEdges) {
      if (e.type === 'sched' && edgeOps.value[e.to]?.removed.includes(e.from))
        continue
      out.push(e)
    }
    for (const [toKey, ops] of Object.entries(edgeOps.value)) {
      for (const from of ops.added)
        out.push({ from, to: toKey, type: 'sched', origin: 'after' })
    }
    return out
  }

  /** 边操作提交（空集 → 删条目） */
  function commitOps(
    key: string,
    ops: { added: string[]; removed: string[] },
  ): void {
    const next = { ...edgeOps.value }
    if (!ops.added.length && !ops.removed.length) delete next[key]
    else next[key] = ops
    edgeOps.value = next
  }

  /**
   * 拖拽连线（Board emit connect 入口）：仅前→后；已存在（基础/条件隐含/已加）→ 静默忽略；
   * 返回 null=已应用或忽略，字符串=拒绝原因（页面 toast）
   */
  function connect(from: string, to: string): string | null {
    const fn = baseNode(from)
    const tn = baseNode(to)
    if (!fn || !tn) return '节点不存在'
    if (fn.seq >= tn.seq)
      return `仅支持前→后依赖：「${from}」不是「${to}」的前置步骤`
    if (
      effectiveAfterList(tn).includes(from) ||
      whenStepRefs(tn).includes(from)
    )
      return null
    const ops = { ...(edgeOps.value[to] ?? { added: [], removed: [] }) }
    if (ops.removed.includes(from))
      ops.removed = ops.removed.filter((k) => k !== from)
    else ops.added = [...ops.added, from]
    commitOps(to, ops)
    return null
  }

  /**
   * 删除调度边（Board emit delEdge 入口）：条件表达式隐含引用不可删（改后仍会被隐含）；
   * 否则物化移除（结果可为 []）；返回 null=已应用，字符串=拒绝原因
   */
  function delEdge(from: string, to: string): string | null {
    const tn = baseNode(to)
    if (!tn) return '节点不存在'
    if (whenStepRefs(tn).includes(from))
      return '该依赖由条件表达式隐含引用（需先修改 when 条件）'
    const ops = { ...(edgeOps.value[to] ?? { added: [], removed: [] }) }
    if (ops.added.includes(from))
      ops.added = ops.added.filter((k) => k !== from)
    else if (!ops.removed.includes(from)) ops.removed = [...ops.removed, from]
    commitOps(to, ops)
    return null
  }

  /** 单步最终 after（edits 通道值）：无操作 → undefined（不改动）；有 → 物化数组 */
  function finalAfterOf(key: string): string[] | undefined {
    const tn = baseNode(key)
    const ops = edgeOps.value[key]
    if (!tn || !ops) return undefined
    const out = baseAfterList(tn).filter((k) => !ops.removed.includes(k))
    for (const k of ops.added) if (!out.includes(k)) out.push(k)
    return out
  }

  /** 画布节点标题 overlay（编辑模式下由 boardNodes 调用；非编辑态 overrides 为空 → 恒原值） */
  function titleOf(node: TemplateCanvasNode): string {
    return overrides.value[node.key]?.title ?? node.title
  }

  /**
   * 应用单步骤 patch（抽屉 emit('edit') 入口）
   * - title：等于原值 → 移除覆盖；空串保留（脏标记 + UI 提示，落盘校验在后续版本）
   * - texts：仅接受 editable 字段；等于原值 → 移除覆盖
   */
  function setPatch(key: string, patch: StepOverride): void {
    const node = baseNode(key)
    if (!node) return
    const cur: StepOverride = { ...(overrides.value[key] ?? {}) }

    if (patch.title !== undefined) {
      if (patch.title === node.title) delete cur.title
      else cur.title = patch.title
    }
    if (patch.texts) {
      const texts: Record<string, string> = { ...(cur.texts ?? {}) }
      for (const [fieldKey, value] of Object.entries(patch.texts)) {
        const field = node.inputFields.find((f) => f.key === fieldKey)
        if (field?.editable && value !== field.value) texts[fieldKey] = value
        else delete texts[fieldKey]
      }
      if (Object.keys(texts).length) cur.texts = texts
      else delete cur.texts
    }

    const next = { ...overrides.value }
    if (cur.title === undefined && cur.texts === undefined) delete next[key]
    else next[key] = cur
    overrides.value = next
  }

  /** 编辑区节点视图（选中节点 → 抽屉编辑区渲染数据） */
  function nodeState(node: TemplateCanvasNode): EditNodeState {
    const ov = overrides.value[node.key]
    return {
      key: node.key,
      title: ov?.title ?? node.title,
      titleDirty: ov?.title !== undefined,
      fields: node.inputFields.map((f) => ({
        key: f.key,
        value: ov?.texts?.[f.key] ?? f.value,
        editable: f.editable,
        dirty: ov?.texts?.[f.key] !== undefined,
      })),
    }
  }

  /** 最小化 edits（无任何改动 → null）：步骤覆盖 + 边操作按 key 合并 */
  function buildEdits(): TemplateEdits | null {
    const byKey = new Map<string, TemplateEditStep>()
    for (const [key, ov] of Object.entries(overrides.value)) {
      const step: TemplateEditStep = { key }
      if (ov.title !== undefined) step.title = ov.title
      if (ov.texts) step.texts = { ...ov.texts }
      byKey.set(key, step)
    }
    for (const key of Object.keys(edgeOps.value)) {
      const after = finalAfterOf(key)
      if (after === undefined) continue
      const step = byKey.get(key) ?? { key }
      step.after = after
      byKey.set(key, step)
    }
    if (!byKey.size) return null
    return { steps: [...byKey.values()] }
  }

  /** 本地预检（不触网）：返回错误列表（空 = 通过）——空标题等落盘前拦截 */
  function validateLocal(): string[] {
    const errs: string[] = []
    for (const [key, ov] of Object.entries(overrides.value)) {
      if (ov.title !== undefined && ov.title.trim() === '')
        errs.push(`步骤「${key}」的标题不能为空`)
    }
    return errs
  }

  /** 重置全部草稿（保留编辑模式；步骤覆盖 + 边操作一起清） */
  function clearAll(): void {
    overrides.value = {}
    edgeOps.value = {}
  }

  /** 退出编辑：关闭模式并丢弃草稿（脏确认由页面负责） */
  function exit(): void {
    clearAll()
    editMode.value = false
  }

  return {
    editMode,
    overrides,
    edgeOps,
    dirty,
    overriddenCount,
    titleOf,
    setPatch,
    nodeState,
    edgesOf,
    connect,
    delEdge,
    buildEdits,
    validateLocal,
    clearAll,
    exit,
  }
}

export type CanvasEditState = ReturnType<typeof useCanvasEdit>
