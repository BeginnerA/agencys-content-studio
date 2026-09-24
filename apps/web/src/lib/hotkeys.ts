// ===== 全局快捷键注册单例 =====
// App 挂载时 initHotkeys() 安装唯一的文档级监听（幂等防重）；
// 各模块 bindHotkey() 注册组合键，返回解绑函数。匹配成功时 preventDefault 并执行处理器（首个命中优先）。
// Esc 关闭覆盖层不走本表：由 lib/esc-layer 的层级仲裁各覆盖层自行处理。

export interface HotkeyCombo {
  /** e.key 小写值（如 'k' / 'escape'） */
  key: string
  /** Ctrl 或 Cmd 任一（跨平台修饰键） */
  ctrlOrMeta?: boolean
  shift?: boolean
  alt?: boolean
}

type HotkeyHandler = (e: KeyboardEvent) => void

interface Binding {
  combo: HotkeyCombo
  handler: HotkeyHandler
}

const bindings: Binding[] = []
let installed = false
let enabled = true

/** 全局开关（组合输入等场景临时禁用） */
export function setHotkeysEnabled(on: boolean): void {
  enabled = on
}

/** 注册组合键；返回解绑函数（组件 onBeforeUnmount 调用） */
export function bindHotkey(
  combo: HotkeyCombo,
  handler: HotkeyHandler,
): () => void {
  const b: Binding = { combo, handler }
  bindings.push(b)
  return () => {
    const i = bindings.indexOf(b)
    if (i >= 0) bindings.splice(i, 1)
  }
}

function match(e: KeyboardEvent, c: HotkeyCombo): boolean {
  // 输入法组合中（中文选词回车等）不触发快捷键
  if (e.isComposing || e.keyCode === 229) return false
  if (e.key.toLowerCase() !== c.key) return false
  if (!!c.ctrlOrMeta !== (e.ctrlKey || e.metaKey)) return false
  if (!!c.shift !== e.shiftKey) return false
  if (!!c.alt !== e.altKey) return false
  return true
}

function onKeydown(e: KeyboardEvent): void {
  if (!enabled) return
  for (const b of bindings) {
    if (match(e, b.combo)) {
      e.preventDefault()
      b.handler(e)
      return
    }
  }
}

/** 安装全局监听（幂等：重复调用只装一次；单页应用常驻不卸载） */
export function initHotkeys(): void {
  if (installed) return
  installed = true
  window.addEventListener('keydown', onKeydown)
}
