import { computed, reactive, ref, watch } from 'vue'
import { assetApi, creationChatApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type {
  Asset,
  CreationArtifact,
  CreationCandidateStep,
  CreationArtifacts as ArtifactsData,
  ShotBoardData,
} from '../../lib/types'
import type { useEasyCreate } from './use-creation-chat'

type Shot = ArtifactsData['shots'][number]

/**
 * 成果墙逻辑：候选版本 board 缓存与展开态 / 本地重新合成入口（字幕开关） / 统计与筛选 /
 * 预览拉取与坏图记录。从 CreationArtifacts.vue 拆出（[M26-split]，行为零变更），
 * 组件仅保留 <template> 展示与 <style scoped>，脚本装配面经解构保持不变。
 */
export function useCreationArtifacts(s: ReturnType<typeof useEasyCreate>) {
  const artifacts = computed(() => s.state.detail?.artifacts)
  const preview = ref<Asset | null>(null)
  const loading = ref<number | null>(null)
  const error = ref('')
  const brokenThumbs = ref<Set<number>>(new Set())
  let request = 0
  watch(
    () => s.state.currentId,
    () => {
      request++
      preview.value = null
      loading.value = null
      error.value = ''
      brokenThumbs.value = new Set()
      resetCandidates()
      filter.value = 'all'
    },
  )
  // 返修成功后该镜会有新版本：候选缓存与展开态一并丢弃，下一轮投影回显后再重新拉 board
  watch(
    () => s.rework.state.stamp,
    () => resetCandidates(),
  )

  // ===== 候选版本：展开态 / 待应用选择 / board 缓存（按步共享，不逐镜重复拉） =====

  const SETTLED = new Set(['completed', 'failed'])
  const CANDIDATE_STEPS: CreationCandidateStep[] = ['images', 'frames', 'motion']
  /** run 收敛才允许改版本（制作中产物还在长，选了也不知道最终是哪版） */
  const settled = computed(() => SETTLED.has(s.state.detail?.progress?.status ?? ''))
  /** 画面模态走哪一步由方案决定：图文成片=images，动态镜头首帧=frames（与服务端投影同一判定） */
  const imageStep = computed<CreationCandidateStep>(() =>
    s.state.detail?.session.plan?.mode === 'slideshow' ? 'images' : 'frames',
  )

  const expanded = reactive(new Set<string>())
  const pending = reactive<Record<string, number | null>>({})
  const boards = reactive<
    Partial<Record<CreationCandidateStep, ShotBoardData | null>>
  >({})
  const boardError = reactive<Partial<Record<CreationCandidateStep, string>>>({})
  const boardLoading = ref<CreationCandidateStep | null>(null)
  // 重合成说明按需展开（不常驻，避免和「应用选择」的提示抢视线）
  const recomposing = ref(false)
  // 成片字幕开关（「已有成果 → 重新合成」入口）：回显 progress.subtitleBurn；改动后点「重新合成」才落 _compose 生效（零计费、本地重合成）
  const subBurn = ref(true)
  watch(
    () => s.state.detail?.progress?.subtitleBurn,
    (v) => {
      subBurn.value = v !== false
    },
    { immediate: true },
  )
  // 仅当已有成片（run completed 且已交付）时才展示字幕开关与常驻重合成入口
  const hasFilm = computed(() => !!s.state.detail?.result)
  // 字幕精确返修面向 pipeline run（与其余三入口同一 runId）；从真实进度的 runId 取，非会话 id
  const filmRunId = computed(() => s.state.detail?.progress?.runId ?? null)
  let boardEpoch = 0

  function resetCandidates(): void {
    expanded.clear()
    for (const k of Object.keys(pending)) delete pending[k]
    for (const step of CANDIDATE_STEPS) {
      delete boards[step]
      delete boardError[step]
    }
    boardLoading.value = null
    boardEpoch++
    recomposing.value = false
  }

  /** 该镜该模态是否值得给出候选入口（缺文件的占位不可选，不计入可用数） */
  function showCandidates(choice: { candidates: CreationArtifact[] }): boolean {
    return settled.value && choice.candidates.filter((c) => c.available).length > 1
  }

  async function ensureBoard(step: CreationCandidateStep): Promise<void> {
    if (boards[step] || boardLoading.value === step) return
    const id = s.state.currentId
    if (!id) return
    const token = ++boardEpoch
    boardLoading.value = step
    boardError[step] = ''
    try {
      const board = await creationChatApi.board(id, step)
      if (token === boardEpoch && id === s.state.currentId) boards[step] = board
    } catch (e) {
      if (token === boardEpoch) {
        boardError[step] =
          e instanceof Error ? e.message : '候选信息读取失败，可收起后重试。'
      }
    } finally {
      if (token === boardEpoch) boardLoading.value = null
    }
  }

  const keyOf = (step: CreationCandidateStep, shotId: string) =>
    `${step}:${shotId}`
  async function toggleCandidates(
    step: CreationCandidateStep,
    shotId: string,
  ): Promise<void> {
    const key = keyOf(step, shotId)
    if (expanded.has(key)) {
      expanded.delete(key)
      pending[key] = null
      return
    }
    expanded.add(key)
    await ensureBoard(step)
  }

  function pickCandidate(
    step: CreationCandidateStep,
    shotId: string,
    assetId: number,
  ): void {
    pending[keyOf(step, shotId)] = assetId
  }

  /** 应用选择：只提交这一镜的改动（其余镜头由服务端按在用值补全）；成功后清空本地待应用态 */
  async function applyCandidate(
    step: CreationCandidateStep,
    shotId: string,
  ): Promise<void> {
    const key = keyOf(step, shotId)
    const assetId = pending[key]
    if (assetId == null) return
    if (await s.applySelection(step, shotId, assetId)) pending[key] = null
  }

  async function onRecompose(): Promise<void> {
    const ok = await confirmDialog({
      title: '重新合成成片',
      message:
        `本地合成：只把现有素材重新拼成成片，不调用任何付费生成模型、不产生生成费用。${subBurn.value ? '成片将烧录字幕。' : '成片将不含字幕（字幕文件仍生成，可单独下载）。'}确认开始？`,
      confirmText: '重新合成',
    })
    if (!ok) return
    recomposing.value = false
    await s.recompose(subBurn.value)
  }

  const selected = (choice: {
    selected: CreationArtifact | null
  }): CreationArtifact | null => choice.selected

  async function open(a: CreationArtifact): Promise<void> {
    if (!a.available || loading.value !== null) return
    const token = ++request
    loading.value = a.assetId
    error.value = ''
    try {
      const { asset } = await assetApi.detail(a.assetId)
      if (token === request) preview.value = asset
    } catch {
      if (token === request) error.value = '素材当前不可用，请更新状态后重试。'
    } finally {
      if (token === request) loading.value = null
    }
  }

  function markBroken(id: number): void {
    brokenThumbs.value = new Set(brokenThumbs.value).add(id)
  }

  // ===== 成果墙：统计 / 筛选 / 卡片派生 =====

  const FILTERS = [
    { key: 'all', label: '全部' },
    { key: 'reused', label: '复用' },
    { key: 'unavailable', label: '不可用' },
  ] as const
  type FilterKey = (typeof FILTERS)[number]['key']
  const filter = ref<FilterKey>('all')

  const shotHasReused = (shot: Shot) =>
    selected(shot.image)?.reused === true ||
    selected(shot.video)?.reused === true ||
    shot.voices.some((v) => v.reused)
  /** 在用素材文件缺失才算「不可用」（尚未生成的不算，那是进度问题不是素材问题） */
  const shotUnavailable = (shot: Shot) =>
    (selected(shot.image) != null && !selected(shot.image)!.available) ||
    (selected(shot.video) != null && !selected(shot.video)!.available) ||
    shot.voices.some((v) => !v.available)

  const stats = computed(() => {
    const shots = artifacts.value?.shots ?? []
    return {
      n: shots.length,
      reused: shots.filter(shotHasReused).length,
      unavailable: shots.filter(shotUnavailable).length,
      voices: new Set(shots.flatMap((sh) => sh.voices.map((v) => v.assetId)))
        .size,
      docs: artifacts.value?.documents.length ?? 0,
    }
  })

  const shownShots = computed(() => {
    const shots = artifacts.value?.shots ?? []
    if (filter.value === 'reused') return shots.filter(shotHasReused)
    if (filter.value === 'unavailable') return shots.filter(shotUnavailable)
    return shots
  })

  /** 缩略图占位文案（不可用原因分级，供 alt 与占位块共用） */
  function placeholderText(shot: Shot): string {
    const image = selected(shot.image)
    if (image == null) return '画面尚未生成'
    if (brokenThumbs.value.has(image.assetId)) return '点击查看原图'
    return '素材文件不可用'
  }

  /** 卡片可做的动作（模板里避免大量非空断言） */
  interface ShotActions {
    image: CreationArtifact | null
    video: CreationArtifact | null
    voices: CreationArtifact[]
    imageCands: CreationArtifact[]
    videoCands: CreationArtifact[]
  }
  const shotActions = (shot: Shot): ShotActions => ({
    image:
      selected(shot.image) && selected(shot.image)!.available
        ? selected(shot.image)
        : null,
    video: selected(shot.video),
    voices: shot.voices,
    imageCands: showCandidates(shot.image) ? shot.image.candidates : [],
    videoCands: showCandidates(shot.video) ? shot.video.candidates : [],
  })

  return {
    artifacts,
    preview,
    loading,
    error,
    brokenThumbs,
    FILTERS,
    filter,
    stats,
    shownShots,
    imageStep,
    hasFilm,
    filmRunId,
    subBurn,
    recomposing,
    expanded,
    pending,
    boards,
    boardError,
    keyOf,
    selected,
    shotActions,
    shotHasReused,
    placeholderText,
    markBroken,
    open,
    toggleCandidates,
    pickCandidate,
    applyCandidate,
    onRecompose,
  }
}
