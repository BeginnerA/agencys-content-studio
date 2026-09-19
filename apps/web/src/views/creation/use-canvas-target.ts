/** [M28] 创作画布：CanvasTarget；依赖显式注入，原函数体保持不变。 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { creationApi, entityApi, projectApi } from '../../lib/api'
import { confirmDialog } from '../../lib/confirm'
import type {
  Asset,
  CanvasListItem,
  EntityItem,
  Project,
} from '../../lib/types'
import type { CanvasState } from './use-canvas-state'

type Dependencies = Pick<
  CanvasState,
  | 'projectId'
  | 'canvasId'
  | 'toast'
  | 'selectedIds'
  | 'selectedEdgeId'
  | 'doc'
  | 'history'
> & { loadDoc: (silent?: boolean) => Promise<void> }

export function useCanvasTarget(deps: Dependencies) {
  const {
    projectId,
    canvasId,
    toast,
    selectedIds,
    selectedEdgeId,
    doc,
    history,
    loadDoc,
  } = deps

  const route = useRoute()
  const router = useRouter()

  // ===== 目录（项目 / 画布 / 素材面板）=====
  const projects = ref<Project[]>([])
  const canvases = ref<CanvasListItem[]>([])
  const listErr = ref('')
  const palette = ref<Asset[]>([])
  const paletteLoading = ref(false)
  const paletteErr = ref('')
  /** [M17] 素材面板 Tab（图片/视频/音频/实体；前三个沿用资产列表查询，实体走 /entities 合并三 kind） */
  const palKind = ref<'image' | 'video' | 'audio' | 'entity'>('image')
  /** [M17] 实体 Tab 数据（character+scene+prop 合并） */
  const palEntities = ref<EntityItem[]>([])
  const fileInput = ref<HTMLInputElement | null>(null)

  async function loadLists(): Promise<void> {
    try {
      const p = await projectApi.list()
      projects.value = p.items
      listErr.value = ''
      const first = p.items[0]
      if (projectId.value == null && first) goProject(first.id)
    } catch (e) {
      listErr.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function loadCanvases(): Promise<void> {
    const pid = projectId.value
    if (pid == null) {
      canvases.value = []
      return
    }
    try {
      const r = await creationApi.list(pid)
      if (projectId.value !== pid) return
      canvases.value = r.items
      const first = r.items[0]
      if (canvasId.value == null && first) goCanvas(first.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function loadPalette(): Promise<void> {
    const pid = projectId.value
    if (pid == null) {
      palette.value = []
      palEntities.value = []
      return
    }
    paletteLoading.value = true
    paletteErr.value = ''
    try {
      if (palKind.value === 'entity') {
        // [M17] 实体 Tab：项目域 + 全局（服务端 ?project_id= 视角），三 kind 合并展示
        const params = `&project_id=${pid}`
        const [c, s, p] = await Promise.all([
          entityApi.list('character', params),
          entityApi.list('scene', params),
          entityApi.list('prop', params),
        ])
        if (projectId.value !== pid) return
        palEntities.value = [...c.items, ...s.items, ...p.items]
        return
      }
      const r = await projectApi.assets(pid, `?limit=120&kind=${palKind.value}`)
      if (projectId.value !== pid) return
      palette.value = r.items
    } catch (e) {
      paletteErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      paletteLoading.value = false
    }
  }
  watch(palKind, () => void loadPalette())

  function goProject(pid: number): void {
    void router.replace({ path: '/creation', query: { project: String(pid) } })
  }
  function goCanvas(cid: number | null): void {
    const q: Record<string, string> = {}
    if (projectId.value != null) q.project = String(projectId.value)
    if (cid != null) q.canvas = String(cid)
    void router.replace({ path: '/creation', query: q })
  }

  const projSel = computed({
    get: () => (projectId.value == null ? '' : String(projectId.value)),
    set: (v: string) => {
      const id = Number(v)
      if (Number.isFinite(id) && id > 0) goProject(id)
    },
  })
  const canvasSel = computed({
    get: () => (canvasId.value == null ? '' : String(canvasId.value)),
    set: (v: string) => {
      const id = Number(v)
      if (Number.isFinite(id) && id > 0) goCanvas(id)
    },
  })

  // ===== URL 同步 =====
  function syncFromQuery(): void {
    const q = route.query
    const p =
      typeof q.project === 'string' && /^\d+$/.test(q.project)
        ? Number(q.project)
        : null
    const c =
      typeof q.canvas === 'string' && /^\d+$/.test(q.canvas)
        ? Number(q.canvas)
        : null
    const projChanged = p !== projectId.value
    const canvasChanged = c !== canvasId.value
    projectId.value = p
    canvasId.value = c
    if (projChanged) {
      void loadCanvases()
      void loadPalette()
    }
    if (canvasChanged) {
      selectedIds.value = []
      selectedEdgeId.value = null
      doc.value = null
      history.clear() // 换画布：命令栈失效
      if (c != null) void loadDoc()
    }
  }
  // ===== 画布管理（改名 / 新建 / 复制 / 删除）=====
  const renamingCanvas = ref(false)
  const canvasNameDraft = ref('')
  const canvasNameInput = ref<HTMLInputElement | null>(null)

  function startRenameCanvas(): void {
    if (!doc.value) return
    canvasNameDraft.value = doc.value.canvas.name
    renamingCanvas.value = true
    void nextTick(() => canvasNameInput.value?.select())
  }
  async function saveCanvasName(): Promise<void> {
    if (!renamingCanvas.value) return
    renamingCanvas.value = false
    const cid = canvasId.value
    const name = canvasNameDraft.value.trim()
    if (cid == null || !doc.value || !name || name === doc.value.canvas.name)
      return
    try {
      await creationApi.update(cid, { name })
      toast('画布已改名')
      void loadDoc(true)
      void loadCanvases()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function createCanvas(): Promise<void> {
    const pid = projectId.value
    if (pid == null) return
    try {
      const r = await creationApi.create(pid)
      await loadCanvases()
      goCanvas(r.canvas.id)
      toast('已新建画布')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function duplicateCanvas(): Promise<void> {
    const cid = canvasId.value
    if (cid == null) return
    try {
      const r = await creationApi.duplicate(cid)
      await loadCanvases()
      goCanvas(r.canvas.id)
      toast('画布已复制')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeCanvas(): Promise<void> {
    const cid = canvasId.value
    if (cid == null || !doc.value) return
    const ok = await confirmDialog({
      title: '移入回收站',
      message: `将画布「${doc.value.canvas.name}」移入回收站？在途任务将被取消；可稍后在「回收站」中恢复或彻底删除。`,
      confirmText: '移入回收站',
      danger: true,
    })
    if (!ok) return
    try {
      await creationApi.remove(cid)
      doc.value = null
      await loadCanvases()
      const next = canvases.value[0]
      goCanvas(next ? next.id : null)
      toast('画布已移入回收站')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  return {
    route,
    router,
    projects,
    canvases,
    listErr,
    palette,
    paletteLoading,
    paletteErr,
    palKind,
    palEntities,
    fileInput,
    loadLists,
    loadCanvases,
    loadPalette,
    goProject,
    goCanvas,
    projSel,
    canvasSel,
    syncFromQuery,
    renamingCanvas,
    canvasNameDraft,
    canvasNameInput,
    startRenameCanvas,
    saveCanvasName,
    createCanvas,
    duplicateCanvas,
    removeCanvas,
  }
}

export type CanvasTarget = ReturnType<typeof useCanvasTarget>
