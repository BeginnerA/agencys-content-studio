/**
 * 检查器操作域（自 use-inspector-form.ts 逐字迁移，行为零变更）：
 * AI 扩写弹窗 / BGM·字幕资产候选 / 视频抽帧 / 实体参考图挂接。
 * —— 装配约定：ctx 注入 + 首行同名解构，函数体逐字保留（拆分纪律）；
 * form 字段与 buildSpec/persistFormIfNeeded/markFormSaved 真源仍在主 composable。
 */
import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type {
  CanvasAssetLite,
  CreationNodeSpec,
  EntityItem,
  EntityKind,
} from '../../../lib/types'
import { creationApi, entityApi } from '../../../lib/api'
import { asGenSpec } from './internals'
import type { InspectorEmitFn, InspectorProps } from './internals'

export function useInspectorFormOps(ctx: {
  props: InspectorProps
  emit: InspectorEmitFn
  opErr: Ref<string>
  opBusy: Ref<boolean>
  formTouched: Ref<boolean>
  fText: Ref<string>
  fPrompt: Ref<string>
  frameMode: Ref<'first' | 'last' | 'custom' | 'uniform'>
  frameTime: Ref<string>
  uniformCount: Ref<number>
  frameBusy: Ref<boolean>
  entOpen: Ref<boolean>
  buildSpec: (over?: { maskAssetId?: number }) => CreationNodeSpec
  persistFormIfNeeded: () => Promise<void>
  markFormSaved: () => void
}) {
  const {
    props,
    emit,
    opErr,
    opBusy,
    formTouched,
    fText,
    fPrompt,
    frameMode,
    frameTime,
    uniformCount,
    frameBusy,
    entOpen,
    buildSpec,
    persistFormIfNeeded,
    markFormSaved,
  } = ctx

  // ===== AI 扩写（对照弹窗：原/新，可编辑 → 应用 PATCH 入栈） =====
  const expandOpen = ref(false)
  const expandBusy = ref(false)
  const expandErr = ref('')
  const expandSrc = ref('')
  const expandDraft = ref('')
  const expandInstruction = ref('')
  /** 节点切换 / 取消选中时关闭扩写弹窗（结果归属原节点，避免误应用） */
  watch(
    () => props.node?.id ?? null,
    () => {
      expandOpen.value = false
    },
  )

  async function openExpand(): Promise<void> {
    const n = props.node
    if (!n) return
    const src = n.kind === 'text' ? fText.value.trim() : fPrompt.value.trim()
    if (!src) {
      opErr.value = '内容为空，无法扩写'
      return
    }
    opErr.value = ''
    expandErr.value = ''
    try {
      // 先落库表单（服务端扩写取库内已存内容）
      await persistFormIfNeeded()
    } catch (e) {
      opErr.value = e instanceof Error ? e.message : String(e)
      return
    }
    expandSrc.value = src
    expandDraft.value = ''
    expandInstruction.value = ''
    expandOpen.value = true
  }

  async function doExpand(): Promise<void> {
    const n = props.node
    if (!n) return
    expandBusy.value = true
    expandErr.value = ''
    try {
      const r = await creationApi.promptExpand(
        n.id,
        expandInstruction.value.trim() || undefined,
      )
      expandDraft.value = r.prompt
    } catch (e) {
      expandErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      expandBusy.value = false
    }
  }

  async function applyExpand(): Promise<void> {
    const n = props.node
    if (!n || !expandDraft.value.trim()) return
    opBusy.value = true
    opErr.value = ''
    try {
      if (n.kind === 'text') {
        fText.value = expandDraft.value
        await props.applyPatch({
          id: n.id,
          patch: { spec: { text: expandDraft.value } },
          label: '应用扩写',
        })
      } else {
        fPrompt.value = expandDraft.value
        await props.applyPatch({
          id: n.id,
          patch: { spec: buildSpec() },
          label: '应用扩写',
        })
      }
      expandOpen.value = false
      emit('notice', '扩写已应用')
    } catch (e) {
      opErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      opBusy.value = false
    }
  }

  // ===== 提取文本节点 =====
  async function doExtract(): Promise<void> {
    const n = props.node
    if (!n) return
    opBusy.value = true
    opErr.value = ''
    try {
      await persistFormIfNeeded()
      await props.applyExtract(n.id)
      emit('notice', '已提取为文本节点')
    } catch (e) {
      opErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      opBusy.value = false
    }
  }

  // ===== BGM 候选（本画布音频节点/资产产物；含 spec 现值兼容兜底） =====
  const bgmOptions = computed<Array<{ id: number; name: string }>>(() => {
    const out: Array<{ id: number; name: string }> = []
    const seen = new Set<number>()
    const push = (
      id: number | null | undefined,
      name: string | null | undefined,
    ): void => {
      if (id == null || seen.has(id)) return
      seen.add(id)
      out.push({ id, name: name ?? `资产 #${id}` })
    }
    for (const n of props.nodes) {
      if (n.kind === 'asset' && n.asset?.kind === 'audio')
        push(n.assetId, n.asset.name)
    }
    for (const n of props.nodes) {
      if (n.kind !== 'gen' || asGenSpec(n.spec)?.genKind !== 'audio') continue
      if (n.displayTask?.asset?.kind === 'audio')
        push(n.displayTask.resultAssetId, n.displayTask.asset.name)
    }
    const cur = asGenSpec(props.node?.spec)?.bgmAssetId
    if (cur != null) push(cur, `资产 #${cur}（画布外引用）`)
    return out
  })

  // ===== 字幕资产候选（purpose=creation_subtitle 的文本资产；含 spec 现值兼容兜底） =====
  const subtitleOptions = computed<Array<{ id: number; name: string }>>(() => {
    const out: Array<{ id: number; name: string }> = []
    const seen = new Set<number>()
    const push = (
      id: number | null | undefined,
      name: string | null | undefined,
    ): void => {
      if (id == null || seen.has(id)) return
      seen.add(id)
      out.push({ id, name: name ?? `资产 #${id}` })
    }
    const isSub = (a: CanvasAssetLite | null): boolean =>
      !!a &&
      a.kind === 'text' &&
      (a.purpose === 'creation_subtitle' || a.name.endsWith('.srt'))
    for (const n of props.nodes) {
      if (n.kind === 'asset' && isSub(n.asset)) push(n.assetId, n.asset?.name)
    }
    for (const n of props.nodes) {
      if (n.kind !== 'gen' || asGenSpec(n.spec)?.genKind !== 'compose') continue
      if (isSub(n.displayTask?.asset ?? null))
        push(n.displayTask?.resultAssetId, n.displayTask?.asset?.name)
    }
    const cur = asGenSpec(props.node?.spec)?.subtitleAssetId
    if (cur != null) push(cur, `资产 #${cur}（画布外引用）`)
    return out
  })

  // ===== 视频抽帧（gen(video) 显示产物 / asset 视频资产） =====
  const canExtractFrame = computed<boolean>(() => {
    const n = props.node
    if (!n) return false
    if (n.kind === 'asset') return n.asset?.kind === 'video'
    if (n.kind !== 'gen') return false
    return (
      asGenSpec(n.spec)?.genKind === 'video' &&
      (n.assetId != null || n.displayTask?.resultAssetId != null)
    )
  })

  async function doExtractFrame(): Promise<void> {
    const n = props.node
    if (!n || frameBusy.value) return
    if (frameMode.value === 'custom' && !frameTime.value.trim()) {
      opErr.value = '请先填写指定时刻（秒）'
      return
    }
    frameBusy.value = true
    opErr.value = ''
    try {
      if (n.kind === 'gen' && formTouched.value) {
        await props.applyPatch({
          id: n.id,
          patch: { spec: buildSpec() },
          label: '保存参数',
        })
        markFormSaved()
      }
      const r = await creationApi.extractFrame(n.id, {
        mode: frameMode.value,
        time:
          frameMode.value === 'custom' ? Number(frameTime.value) : undefined,
        count: frameMode.value === 'uniform' ? uniformCount.value : undefined,
      })
      if (r.nodes && r.nodes.length > 1) {
        emit(
          'notice',
          `已均匀抽取 ${r.nodes.length} 帧（节点 #${r.nodes.map((x) => x.id).join('、#')}）`,
        )
      } else {
        emit(
          'notice',
          `已抽取帧素材（节点 #${r.node.id} · 资产 #${r.asset.id}）`,
        )
      }
      emit('refresh')
    } catch (e) {
      opErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      frameBusy.value = false
    }
  }

  // ===== 设为实体参考图（内联面板） =====
  const entKind = ref<EntityKind>('character')
  const entList = ref<EntityItem[]>([])
  const entLoading = ref(false)
  const entBusy = ref<number | null>(null)
  const entErr = ref('')

  async function loadEntities(): Promise<void> {
    entLoading.value = true
    entErr.value = ''
    try {
      const r = await entityApi.list(
        entKind.value,
        `&project_id=${props.projectId}`,
      )
      entList.value = r.items
    } catch (e) {
      entErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      entLoading.value = false
    }
  }
  function toggleEntities(): void {
    entOpen.value = !entOpen.value
    if (entOpen.value) void loadEntities()
  }
  watch(entKind, () => {
    if (entOpen.value) void loadEntities()
  })

  async function attachTo(e: EntityItem): Promise<void> {
    const n = props.node
    if (!n || n.assetId == null) return
    entBusy.value = e.id
    entErr.value = ''
    try {
      const r = await creationApi.attachRefAssets(e.id, [n.assetId])
      emit('notice', `已挂接「${e.name}」参考图（新增 ${r.added ?? 0} 张）`)
      entOpen.value = false
    } catch (err) {
      entErr.value = err instanceof Error ? err.message : String(err)
    } finally {
      entBusy.value = null
    }
  }

  return {
    expandOpen,
    expandBusy,
    expandErr,
    expandSrc,
    expandDraft,
    expandInstruction,
    openExpand,
    doExpand,
    applyExpand,
    doExtract,
    bgmOptions,
    subtitleOptions,
    canExtractFrame,
    doExtractFrame,
    entKind,
    entList,
    entLoading,
    entBusy,
    entErr,
    toggleEntities,
    attachTo,
  }
}
