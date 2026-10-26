/**
 * M66 离线回归（前端资源与契约三节）：
 * 1. chain-busy：续段忙锁由「请求自身」释放，切会话 / 离开不再把它永久卡住（审查项 d）；
 * 2. studio-dispose：useStudio().dispose() 成对注销本实例 handler 并 leave 房间（审查项 e）；
 * 3. api-timeout：统一请求有超时上限，且同步长任务走 LONG（审查项 g）。
 *
 * 全程零网络：socket 用假 location + 假 WebSocket（不握手，仅本地收发）；fetch 换成可控桩；
 * AbortSignal.timeout 换成「记录毫秒数 + 5ms 后真 abort」的替身，以触发同一异常路径。
 *
 * 运行（仓库根）：
 *   apps/server/node_modules/.bin/tsx apps/web/scripts/probe-m66-frontier.ts [--section=chain-busy|studio-dispose|api-timeout]
 */
import assert from 'node:assert/strict'
import { reactive } from 'vue'

const results: string[] = []
function check(ok: boolean, message: string): void {
  assert.ok(ok, message)
  results.push(`PASS ${message}`)
}

// ===== 1. 续段忙锁 =====

interface StubDetail {
  session: { workflowId: number | null; runId: number | null }
}

function makeHost(currentId: number, wfId: number | null = 9) {
  return reactive({
    currentId,
    detail: { session: { workflowId: wfId, runId: 1 } } as unknown as StubDetail,
    error: '',
    notice: '',
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function checkChainBusy(): Promise<void> {
  const { createChainAdvance } = await import('../src/views/easy-create/use-creation-chain')
  const host = makeHost(1)
  const calls: Array<{ id: number; key: string }> = []
  const commits: number[] = []
  let pollCount = 0
  let gate = deferred<{ ok: boolean; body: unknown }>()
  const api = {
    advanceChain: (id: number, body: { idempotencyKey: string }) => {
      calls.push({ id, key: body.idempotencyKey })
      return gate.promise
    },
  }
  const chain = createChainAdvance(host as never, {
    commit: () => commits.push(1),
    polling: () => {
      pollCount += 1
    },
  } as never, api as never)

  // A1 正常成功：busy 释放、commit 落库、开始轮询
  const p1 = chain.advanceChain()
  check(chain.advanceBusy.busy === true, '批准后 busy 立即置位（连点被吞）')
  const dup = await chain.advanceChain()
  check(dup === false && calls.length === 1, 'busy 期间重复点击不再起段（同一次点击只有一个幂等键）')
  gate.resolve({ ok: true, body: {} })
  check((await p1) === true, '批准成功返回 true')
  check(chain.advanceBusy.busy === false, '成功路径释放 busy')
  check(commits.length === 1 && pollCount === 1, '成功后 commit 快照并进入轮询')

  // A2 审查项 d 本体：请求未落定就切走会话 → busy 必须仍被释放
  const host2 = makeHost(2)
  let calls2 = 0
  const gate2 = deferred<{ ok: boolean; body: unknown }>()
  const chain2 = createChainAdvance(host2 as never, { commit: () => undefined, polling: () => undefined } as never, {
    advanceChain: () => {
      calls2 += 1
      return gate2.promise
    },
  } as never)
  const p2 = chain2.advanceChain()
  host2.currentId = 3 // 用户切到别的会话（或直接离开）
  gate2.resolve({ ok: true, body: {} })
  await p2
  check(calls2 === 1, '离开前请求确已发出（时序前提）')
  check(chain2.advanceBusy.busy === false, '切走会话后请求落定仍释放 busy（旧实现会永久卡住续段入口）')

  // A3 迟到的失败不回写新会话的错误位
  const host3 = makeHost(4)
  const gate3 = deferred<{ ok: boolean; body: unknown }>()
  const chain3 = createChainAdvance(host3 as never, { commit: () => undefined, polling: () => undefined } as never, {
    advanceChain: () => gate3.promise,
  } as never)
  const p3 = chain3.advanceChain()
  host3.currentId = 5
  host3.error = ''
  gate3.reject(new Error('网络中断'))
  check((await p3) === false, '失败路径返回 false')
  check(host3.error === '', '迟到的失败不污染切换后的会话错误位')

  // A4 reset()：立即释放 + 使在途请求失去写回资格
  const host4 = makeHost(6)
  const gate4 = deferred<{ ok: boolean; body: unknown }>()
  const commits4: number[] = []
  const chain4 = createChainAdvance(host4 as never, { commit: () => commits4.push(1), polling: () => undefined } as never, {
    advanceChain: () => gate4.promise,
  } as never)
  const p4 = chain4.advanceChain()
  chain4.reset()
  check(chain4.advanceBusy.busy === false, 'reset() 立即释放 busy（不等请求落定）')
  gate4.resolve({ ok: true, body: {} })
  await p4
  check(commits4.length === 1, 'reset 后在途请求仍把结果交回 commit（由会话守卫决定是否上屏）')

  // A5 幂等键：失败后原样重试复用同键（服务端按同键去重，不二次起段）；段推进（runId 变）后换新键
  const host5 = makeHost(7)
  const keys: string[] = []
  let failNext = true
  const chain5 = createChainAdvance(host5 as never, { commit: () => undefined, polling: () => undefined } as never, {
    advanceChain: (_id: number, body: { idempotencyKey: string }) => {
      keys.push(body.idempotencyKey)
      if (failNext) {
        failNext = false
        return Promise.reject(new Error('网络中断'))
      }
      return Promise.resolve({ ok: true, body: {} })
    },
  } as never)
  check((await chain5.advanceChain()) === false, '首发失败返回 false（键保留待重试）')
  check((await chain5.advanceChain()) === true, '重试成功')
  check(keys.length === 2 && keys[0] === keys[1], '同一在制段重试复用同幂等键（不重复起段/计费）')
  host5.detail = { session: { workflowId: 9, runId: 2 } } as unknown as StubDetail
  await chain5.advanceChain()
  check(keys[2] !== keys[1], '段推进（runId 变）后换新幂等键，下一段可再次批准')
}

// ===== 2. socket disposer =====

async function checkStudioDispose(): Promise<void> {
  ;(globalThis as Record<string, unknown>).location = {
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: '1',
    host: '127.0.0.1:1',
    origin: 'http://127.0.0.1:1',
    href: 'http://127.0.0.1:1/',
    pathname: '/',
    search: '',
  }
  class FakeWebSocket {
    static OPEN = 1
    readyState = 0
    binaryType = 'arraybuffer'
    close(): void {}
    send(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket

  const { getSocket, studioOff, studioOn, useStudio } = await import('../src/lib/socket')
  const socket = getSocket() as unknown as {
    connected: boolean
    onpacket: (p: { nsp: string; type: number; data: unknown[] }) => void
    onAnyOutgoing: (l: (...a: unknown[]) => void) => void
  }
  socket.connected = true // 未连接时 onevent 只进 receiveBuffer；置真即走本地派发

  const outgoing: string[] = []
  socket.onAnyOutgoing((...a: unknown[]) => outgoing.push(JSON.stringify(a)))
  const fire = (type: string, extra: Record<string, unknown> = {}) =>
    socket.onpacket({ nsp: '/studio', type: 2, data: ['studio.event', { type, ...extra }] })

  const counts = { step: 0, gate: 0, global: 0 }
  const studio = useStudio(7, 42)
  studio.on('run.step', (() => {
    counts.step += 1
  }) as never)
  studio.on('run.gate', (() => {
    counts.gate += 1
  }) as never)
  studio.join()
  const globalHandler = () => {
    counts.global += 1
  }
  studioOn('run.step', globalHandler as never)

  fire('run.step', { runId: 7 })
  check(counts.step === 1 && counts.global === 1, '订阅后事件到达即派发（本实例 + 全局各一次）')
  check(outgoing.some((o) => o.includes('join') && o.includes('run:7')), 'join 了 run:7 房间')

  studio.dispose()
  fire('run.step', { runId: 7 })
  fire('run.gate', { runId: 7 })
  check(counts.step === 1, 'dispose 注销本实例 handler（再收到同型事件不触发旧闭包）')
  check(counts.gate === 0, 'dispose 同时注销其余事件订阅')
  check(counts.global === 2, 'dispose 不误伤他人经 studioOn 的订阅（只清自己登记的）')
  check(outgoing.some((o) => o.includes('leave') && o.includes('run:7')), 'dispose 会 leave 房间')
  studio.dispose()
  fire('run.step', { runId: 7 })
  check(counts.step === 1, 'dispose 幂等：重复调用不重复派发/注销报错')

  studioOff('run.step', globalHandler as never)
  const globalBefore = counts.global
  fire('run.step', { runId: 7 })
  check(counts.global === globalBefore, 'studioOff 与 studioOn 成对（全局订阅可注销）')

  // 调用方接线：详情页卸载必须走 dispose，而不是只 leave
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../src/views/run-detail/use-run-detail.ts', import.meta.url), 'utf8')
  const unmount = /onBeforeUnmount\(\(\)\s*=>\s*\{[\s\S]*?\}\)/.exec(src)?.[0] ?? ''
  check(unmount.includes('studio.dispose()'), 'run-detail 卸载调用 studio.dispose()')
  check(!/studio\.leave\(\)/.test(unmount), 'run-detail 卸载不再只 leave（漏注销是审查项 e 的成因）')
}

// ===== 3. 请求超时 =====

async function checkApiTimeout(): Promise<void> {
  const { ApiError, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS, api } = await import('../src/lib/api/core')
  const seenTimeouts: number[] = []

  // fetch 桩：永不自行返回，只在 signal abort 时按真实 fetch 的语义 reject
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener(
        'abort',
        () => reject(signal.reason ?? new Error('aborted')),
        { once: true },
      )
    })
  }) as typeof fetch

  // AbortSignal.timeout 替身：记录调用方请求的毫秒上限，并在 5ms 后真正 abort（等价于真等 120s）
  const original = AbortSignal.timeout
  AbortSignal.timeout = ((ms: number) => {
    seenTimeouts.push(ms)
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), 5)
    return controller.signal
  }) as typeof AbortSignal.timeout

  try {
    const err = await api.get('/api/v1/runs/1').then(() => null, (e: unknown) => e)
    check(err instanceof ApiError, '挂死的 GET 抛 ApiError（而非永不落定的 Promise）')
    check((err as ApiError).code === 'timeout', `超时错误码为 timeout（实际 ${(err as ApiError).code}）`)
    check(/仍在处理/.test((err as ApiError).message), '超时文案不宣称失败，只引导刷新对账')
    check(seenTimeouts[0] === DEFAULT_TIMEOUT_MS, `默认上限 = DEFAULT_TIMEOUT_MS（实际 ${seenTimeouts[0]}ms）`)

    const { configApi } = await import('../src/lib/api/config')
    seenTimeouts.length = 0
    const p = configApi.test(1).catch(() => null)
    check(seenTimeouts[0] === LONG_TIMEOUT_MS, '连通测试（真实 ping）走 LONG 上限')
    await p

    const { creationApi } = await import('../src/lib/api/canvas')
    seenTimeouts.length = 0
    const pe = creationApi.exportZip(3).catch(() => null)
    check(seenTimeouts[0] === LONG_TIMEOUT_MS, '画布打包导出走 LONG 上限')
    await pe

    const { entityApi, stylePresetApi } = await import('../src/lib/api/assets')
    seenTimeouts.length = 0
    const pp = entityApi.polish([1, 2]).catch(() => null)
    check(seenTimeouts[0] === LONG_TIMEOUT_MS, '批量润色（串行文本模型）走 LONG 上限')
    await pp
    seenTimeouts.length = 0
    const ps = stylePresetApi.extract(1, [2]).catch(() => null)
    check(seenTimeouts[0] === LONG_TIMEOUT_MS, '画风提取（视觉模型）走 LONG 上限')
    await ps

    // 正常路径不受影响：桩立即返回 JSON
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )) as typeof fetch
    const ok = await api.get<{ items: unknown[] }>('/api/v1/runs')
    check(Array.isArray(ok.items), '未超时路径仍正常解析 JSON')
  } finally {
    AbortSignal.timeout = original
  }
}

const sections: Record<string, () => Promise<void>> = {
  'chain-busy': checkChainBusy,
  'studio-dispose': checkStudioDispose,
  'api-timeout': checkApiTimeout,
}

const only = process.argv.find((a) => a.startsWith('--section='))?.slice('--section='.length)
const names = only ? [only] : Object.keys(sections)
let failed = 0
for (const name of names) {
  const fn = sections[name!]
  if (!fn) {
    console.error(`未知 section：${name}（可选 ${Object.keys(sections).join('|')}）`)
    process.exit(1)
  }
  console.log(`──── section: ${name} ────`)
  try {
    await fn()
  } catch (e) {
    failed += 1
    console.error(`  FAIL  ${e instanceof Error ? e.message : String(e)}`)
  }
}
for (const r of results) console.log(`  ${r}`)
console.log(
  failed === 0
    ? `\n==== M66 前端资源/契约 探针结果: 全部通过（${names.length} 节 / ${results.length} 条断言）====`
    : `\n==== M66 前端资源/契约 探针结果: ${failed} 节失败 ====`
)
process.exit(failed === 0 ? 0 : 1)
