/**
 * M65 离线回归：路由参数变化的详情视图必须重建（run/batch/project/会话详情读的是 route.params 快照）。
 *
 * 两节：
 * 1. reuse-semantics：Vue + vue-router 的真实复用语义（自定义无 DOM 渲染器）——
 *    顶层 RouterView 以「路径」为键时，/runs/1 → /runs/2 重建视图、仅 query 变化不重建；
 *    以 fullPath 为键会把画布/列表筛选态一起炸掉，故必须只用路径。
 * 2. app-wiring：编译 App.vue 模板，断言顶层 RouterView 确实带路径键（防止改动被回退）。
 *
 * 运行（仓库根）：
 *   apps/server/node_modules/.bin/tsx apps/web/scripts/probe-m65-route-key.ts
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  createRenderer,
  defineComponent,
  h,
  nextTick,
  type RendererOptions,
} from 'vue'
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  useRoute,
  type RouteRecordRaw,
} from 'vue-router'

interface FakeNode {
  tag?: string
  text?: string
  children: FakeNode[]
  parent?: FakeNode | null
}

const nodeOps: RendererOptions<FakeNode> = {
  createElement: (tag) => ({ tag, children: [] }),
  createText: (text) => ({ text, children: [] }),
  createComment: (text) => ({ text, children: [] }),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  parentNode: (node) => node.parent ?? null,
  nextSibling: (node) => {
    const p = node.parent
    if (!p) return null
    const i = p.children.indexOf(node)
    return i < 0 ? null : (p.children[i + 1] ?? null)
  },
  remove: (node) => {
    const p = node.parent
    if (p) p.children = p.children.filter((c) => c !== node)
    node.parent = null
  },
  insert: (child, parent, anchor) => {
    child.parent = parent
    if (anchor) {
      const i = parent.children.indexOf(anchor)
      parent.children.splice(i < 0 ? parent.children.length : i, 0, child)
    } else {
      parent.children.push(child)
    }
  },
  querySelector: () => null,
  setScopeId: () => undefined,
  cloneNode: (node) => ({ ...node, children: [], parent: null }),
  patchProp: () => undefined,
  insertStaticContent: () => [null, null] as [FakeNode, FakeNode],
}

const results: string[] = []
function check(ok: boolean, message: string): void {
  assert.ok(ok, message)
  results.push(`PASS ${message}`)
}

function keyedApp(keyOf: (path: string, fullPath: string) => string) {
  const { createApp } = createRenderer(nodeOps)
  const setups: number[] = []
  const Detail = defineComponent({
    name: 'RunDetailStub',
    setup() {
      const route = useRoute()
      setups.push(Number(route.params.id))
      return () => null
    },
  })
  const CanvasStub = defineComponent({
    name: 'CanvasStub',
    setup() {
      setups.push(0)
      return () => null
    },
  })
  const routes: RouteRecordRaw[] = [
    { path: '/runs/:id(\\d+)', component: Detail },
    { path: '/creation', component: CanvasStub },
  ]
  const router = createRouter({ history: createMemoryHistory(), routes })
  // 与 App.vue 同构：顶层 RouterView + 复用键
  const Root = defineComponent({
    setup() {
      const route = useRoute()
      return () => h(RouterView, { key: keyOf(route.path, route.fullPath) })
    },
  })
  const app = createApp(Root)
  app.use(router)
  return { app, router, setups }
}

async function checkReuseSemantics(): Promise<void> {
  const { app, router, setups } = keyedApp((path) => path)
  await router.push('/runs/1')
  const root = { tag: 'root', children: [], parent: null } as FakeNode
  app.mount(root)
  check(setups.length === 1 && setups[0] === 1, '初始 /runs/1 建一次详情视图')
  await router.push('/runs/2')
  await nextTick()
  await nextTick()
  check(
    setups.length === 2 && setups[1] === 2,
    `路径键下 /runs/1 → /runs/2 重建视图（实际建了 ${setups.length} 次：${setups.join(',')}）`,
  )
  app.unmount()
}

async function checkQueryKeepsInstance(): Promise<void> {
  const { app, router, setups } = keyedApp((path) => path)
  await router.push('/creation?project=1&canvas=10')
  const root = { tag: 'root', children: [], parent: null } as FakeNode
  app.mount(root)
  check(setups.length === 1, '画布视图初始建一次')
  await router.push('/creation?project=1&canvas=11')
  await nextTick()
  await nextTick()
  check(
    setups.length === 1,
    `仅 query 变化不重建视图，画布/筛选态保留（实际建了 ${setups.length} 次）`,
  )
  app.unmount()
}

async function checkAppWiring(): Promise<void> {
  const sfc = await readFile(
    fileURLToPath(new URL('../src/App.vue', import.meta.url)),
    'utf8',
  )
  const { parse, compileTemplate } = await import('vue/compiler-sfc')
  const { descriptor, errors } = parse(sfc, { filename: 'App.vue' })
  assert.equal(errors.length, 0, `App.vue 解析失败：${errors[0]?.message}`)
  const { code } = compileTemplate({
    source: descriptor.template!.content,
    filename: 'App.vue',
    id: 'app-probe',
  })
  const usage =
    /_create(?:Block|VNode)\(_component_RouterView,\s*\{[^}]*\}/.exec(code)
  assert.ok(usage, 'App.vue 顶层未渲染带 props 的 RouterView')
  const snippet = usage[0]
  check(
    /key:.*\.path/.test(snippet),
    'App.vue 的 RouterView 以路由路径为键（切换 run/batch/项目 id 重建视图）',
  )
  check(
    !/fullPath/.test(snippet),
    '键不含 fullPath（query 变化不得炸掉画布/筛选态）',
  )
}

const sections: Array<[string, () => Promise<void>]> = [
  ['path-key-rebuilds', checkReuseSemantics],
  ['query-keeps-instance', checkQueryKeepsInstance],
  ['app-wiring', checkAppWiring],
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
process.exit(failed === 0 ? 0 : 1)
