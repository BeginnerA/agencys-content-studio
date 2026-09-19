/**
 * [M17] 创作画布命令栈（撤销 / 重做）
 * - 命令 = { label, undo(), redo() }：调用方把每一步写操作封装为命令（新建/删除/复制/移动/连线/整理…）
 * - push 在写操作成功后调用；栈上限 limit（默认 100，超限丢最旧）；push 清空 redo 栈
 * - undo/redo 执行失败 → 清空双栈并向上抛（调用方 toast）——防栈内命令继续引用已失效的实体
 * - busy 防重入：命令执行期间再次触发 undo/redo 直接忽略（防连按快捷键产生交错写）
 */
import { ref, type Ref } from 'vue'

export interface CanvasCommand {
  /** 行为描述（toast：「已撤销：移动节点」） */
  label: string
  undo: () => Promise<void> | void
  redo: () => Promise<void> | void
}

export interface CanvasHistory {
  push: (cmd: CanvasCommand) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  clear: () => void
  canUndo: Ref<boolean>
  canRedo: Ref<boolean>
  /** 下一次撤销/重做的行为描述（null = 栈空；顶栏按钮 tooltip 用） */
  undoLabel: Ref<string | null>
  redoLabel: Ref<string | null>
}

export function createCanvasHistory(
  opts: { limit?: number } = {},
): CanvasHistory {
  const limit = opts.limit ?? 100
  const undoStack: CanvasCommand[] = []
  const redoStack: CanvasCommand[] = []
  const canUndo = ref(false)
  const canRedo = ref(false)
  const undoLabel = ref<string | null>(null)
  const redoLabel = ref<string | null>(null)
  let busy = false

  function sync(): void {
    canUndo.value = undoStack.length > 0
    canRedo.value = redoStack.length > 0
    undoLabel.value = undoStack[undoStack.length - 1]?.label ?? null
    redoLabel.value = redoStack[redoStack.length - 1]?.label ?? null
  }

  function push(cmd: CanvasCommand): void {
    undoStack.push(cmd)
    if (undoStack.length > limit) undoStack.shift()
    redoStack.length = 0
    sync()
  }

  function clear(): void {
    undoStack.length = 0
    redoStack.length = 0
    sync()
  }

  async function undo(): Promise<void> {
    if (busy) return
    const cmd = undoStack.pop()
    if (!cmd) return
    busy = true
    try {
      await cmd.undo()
      redoStack.push(cmd)
    } catch (err) {
      clear()
      throw err
    } finally {
      busy = false
      sync()
    }
  }

  async function redo(): Promise<void> {
    if (busy) return
    const cmd = redoStack.pop()
    if (!cmd) return
    busy = true
    try {
      await cmd.redo()
      undoStack.push(cmd)
    } catch (err) {
      clear()
      throw err
    } finally {
      busy = false
      sync()
    }
  }

  return { push, undo, redo, clear, canUndo, canRedo, undoLabel, redoLabel }
}
