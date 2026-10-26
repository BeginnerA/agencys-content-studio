/**
 * M65 离线回归：切换画布后的迟到写响应不得污染新画布的命令栈 / 选区。
 * 仅替换 global fetch，不访问网络、不读写正式数据；依赖真实 composable 与真实 history。
 *
 * 运行（仓库根）：
 *   apps/server/node_modules/.bin/tsx apps/web/scripts/probe-m65-canvas.ts
 */
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { createCanvasHistory } from '../src/lib/canvas-history'
import { useCanvasBatch } from '../src/views/creation/use-canvas-batch'
import { useCanvasCommands } from '../src/views/creation/use-canvas-commands'

interface PendingRequest {
  url: string
  method: string
  resolve: (body: unknown) => void
}

const pending: PendingRequest[] = []
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  return new Promise<Response>((resolve) => {
    pending.push({
      url,
      method: init?.method ?? 'GET',
      resolve: (body) =>
        resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    })
  })
}) as typeof fetch

function take(path: string): PendingRequest {
  const i = pending.findIndex((p) => p.url.includes(path))
  if (i < 0)
    throw new Error(
      `没有待决请求 ${path}；当前：${pending.map((p) => p.url).join(', ') || '（空）'}`,
    )
  return pending.splice(i, 1)[0]!
}

function makeDoc(
  canvasId: number,
  nodes: unknown[] = [],
): Record<string, unknown> {
  return {
    canvas: { id: canvasId, projectId: 7, name: `画布 ${canvasId}` },
    nodes,
    edges: [],
    groups: [],
  }
}

function makeHarness() {
  const canvasId = ref<number | null>(101)
  const projectId = ref<number | null>(7)
  const doc = ref<Record<string, unknown> | null>(
    makeDoc(101, [
      {
        id: 1,
        kind: 'text',
        x: 0,
        y: 0,
        spec: { text: '旧画布文本' },
        title: null,
        seq: null,
      },
    ]),
  )
  const nodes = computed(
    () => (doc.value?.nodes as Array<Record<string, unknown>>) ?? [],
  )
  const edges = computed(
    () => (doc.value?.edges as Array<Record<string, unknown>>) ?? [],
  )
  const selectedIds = ref<number[]>([1])
  const selectedEdgeId = ref<number | null>(null)
  const history = createCanvasHistory()
  const toasts: string[] = []
  const loadDocCalls: boolean[] = []
  const toast = (msg: string) => toasts.push(msg)
  const loadDoc = async (silent?: boolean) => {
    loadDocCalls.push(!!silent)
  }
  const loadPalette = async () => {}

  const commands = useCanvasCommands({
    doc,
    canvasId,
    nodes,
    history,
    toast,
    selectedIds,
    selectedEdgeId,
    projectId,
    loadDoc,
    loadPalette,
    edges,
  })
  const batch = useCanvasBatch({
    canvasId,
    nodes,
    history,
    toast,
    selectedIds,
    loadDoc,
  })

  /** 模拟 syncFromQuery 的换画布分支 */
  function switchTo(id: number): void {
    canvasId.value = id
    selectedIds.value = []
    selectedEdgeId.value = null
    doc.value = makeDoc(id)
    history.clear()
  }

  return {
    canvasId,
    doc,
    selectedIds,
    history,
    toasts,
    loadDocCalls,
    commands,
    batch,
    switchTo,
  }
}

const results: string[] = []
function check(ok: boolean, message: string): void {
  assert.ok(ok, message)
  results.push(`PASS ${message}`)
}

async function checkLateAdd(): Promise<void> {
  const h = makeHarness()
  const p = h.commands.addNodesCommand(
    101,
    [{ kind: 'text', spec: { text: '迟到节点' }, x: 10, y: 10 }],
    '新建文本节点',
  )
  const req = take('/canvases/101/nodes')
  h.switchTo(202)
  req.resolve({ node: { id: 9001 } })
  const ids = await p
  check(ids.length === 1, '迟到新建仍返回服务端节点 id')
  check(!h.history.canUndo.value, '换画布后迟到的新建响应不得进入撤销栈')
  check(h.selectedIds.value.length === 0, '迟到新建不得改写新画布选区')
}

async function checkClearDuringUndo(): Promise<void> {
  const history = createCanvasHistory()
  let finish!: () => void
  history.push({
    label: '移动节点',
    undo: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    redo: async () => {},
  })
  const p = history.undo()
  history.clear()
  finish()
  await p
  check(!history.canRedo.value, '撤销在途时 clear 不得把旧画布命令写回重做栈')
}

async function checkLateCopy(): Promise<void> {
  const h = makeHarness()
  const p = h.commands.onCopySelected()
  const req = take('/canvases/101/nodes/copy')
  h.switchTo(202)
  req.resolve({
    nodes: [{ id: 9101 }, { id: 9102 }],
    edges: [],
  })
  await p
  check(!h.history.canUndo.value, '换画布后迟到的复制不得进入撤销栈')
  check(
    h.selectedIds.value.length === 0,
    '迟到复制不得把新画布选区改成旧节点 id',
  )
}

async function checkLateArrange(): Promise<void> {
  const h = makeHarness()
  const p = h.batch.runArrange('align-left', [1])
  const req = take('/canvases/101/arrange')
  h.switchTo(202)
  req.resolve({
    updated: 1,
    positions: [{ id: 1, x: 5, y: 5 }],
  })
  await p
  check(!h.history.canUndo.value, '换画布后迟到的整理不得进入撤销栈')
}

const sections: Array<[string, () => Promise<void>]> = [
  ['late-add', checkLateAdd],
  ['clear-during-undo', checkClearDuringUndo],
  ['late-copy', checkLateCopy],
  ['late-arrange', checkLateArrange],
]

let failed = 0
for (const [name, fn] of sections) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (e) {
    failed += 1
    console.error(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}
console.log(
  failed === 0
    ? `全部通过（${sections.length} 节，${results.length} 条断言）`
    : `${failed} 节失败`,
)
process.exitCode = failed === 0 ? 0 : 1
