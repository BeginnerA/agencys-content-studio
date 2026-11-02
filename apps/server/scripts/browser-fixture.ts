/**
 * 隔离浏览器夹具（手动运行，不由 run-probes 启动）。
 *
 * 启动后返回仅回环的三个地址与临时目录：
 * - server：隔离 checkout 的 Hono 服务（临时 ROOT/DATA/WORKSPACE，绝不读写真实 .env / data）
 * - web：执行工作树的 Vite dev（代理到隔离 server）
 * - stub：OpenAI 兼容假模型，只回答剧情提取与固定文本；其余路径/模型/凭证一律拒绝
 *
 * 退出（Ctrl+C / SIGTERM）关闭本脚本创建的全部进程并删除临时目录（M70_KEEP_FIXTURE=1 保留）。
 * 运行：node .../safe-run.mjs script ../server/scripts/browser-fixture.ts 或直接 tsx。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const FIXTURE_TEMPLATE = 'm70-browser-episode'
const FIXTURE_MODEL = 'm70-fixture-model'
const FIXTURE_API_KEY = 'm70-fixture-key'
const SCRIPT_TEXT = '甲受伤。钥匙归甲。观众知道甲是卧底。乙尚不知甲是卧底。红信封未开。'
const HOST = '127.0.0.1'
const ALLOW_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'TERM',
])

function assertUnconfiguredCheckout(): void {
  for (const rel of ['.env', 'data/secrets.json']) {
    if (existsSync(join(REPO, rel))) throw new Error(`拒绝运行：执行工作树存在真实配置 ${rel}`)
  }
}

/** 仅复制 git 跟踪的源码资产，避免把用户自定义模板/提示词/合规词库带进夹具。 */
function copyTracked(tempRoot: string, paths: string[]): void {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: REPO })
  for (const rel of out.toString('utf8').split('\0')) {
    if (!rel) continue
    const dest = join(tempRoot, rel)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(REPO, rel), dest)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, HOST, () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(); reject(new Error('无法分配回环端口')); return }
      srv.close(() => resolvePort(addr.port))
    })
  })
}

interface LlmCall { kind: string; path: string; model: string; detail?: string }

/** 假模型：只实现 OpenAI 兼容 chat completions；提取请求按 sourceText 生成带精确引用的草稿。 */
function startStub(logFile: string, calls: LlmCall[]): Promise<{ server: Server; url: string }> {
  const record = (entry: LlmCall) => {
    calls.push(entry)
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  }
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const chat = (res: ServerResponse, content: string, promptChars: number) => {
    reply(res, 200, {
      id: `chatcmpl-m70-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: FIXTURE_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: Math.ceil(content.length / 4),
        total_tokens: Math.ceil((promptChars + content.length) / 4) },
    })
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || (path !== '/v1/chat/completions' && path !== '/chat/completions')) {
      record({ kind: 'refused', path, model: '', detail: 'only chat completions are stubbed' })
      return reply(res, 403, { error: { message: 'm70-fixture: 仅允许回环假模型的 chat completions' } })
    }
    if (req.headers.authorization !== `Bearer ${FIXTURE_API_KEY}`) {
      record({ kind: 'refused', path, model: '', detail: 'unexpected credential' })
      return reply(res, 401, { error: { message: 'm70-fixture: 拒绝未配置的凭证' } })
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: { model?: unknown; messages?: Array<{ role?: unknown; content?: unknown }>; stream?: unknown }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        record({ kind: 'refused', path, model: '', detail: 'invalid json' })
        return reply(res, 400, { error: { message: 'm70-fixture: 请求体非 JSON' } })
      }
      const model = typeof body.model === 'string' ? body.model : ''
      if (model !== FIXTURE_MODEL) {
        record({ kind: 'refused', path, model, detail: 'unexpected provider/model' })
        return reply(res, 403, { error: { message: 'm70-fixture: 拒绝其他供应商/模型请求' } })
      }
      if (body.stream === true) {
        record({ kind: 'refused', path, model, detail: 'streaming not stubbed' })
        return reply(res, 400, { error: { message: 'm70-fixture: 不提供流式输出' } })
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const textOf = (content: unknown): string =>
        typeof content === 'string' ? content
          : Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
            : ''
      const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n')
      const user = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n')
      const promptChars = system.length + user.length
      if (system.includes('剧情连续性结构提取')) {
        record({ kind: 'continuity_extract', path, model, detail: `user=${user.length}` })
        return chat(res, JSON.stringify(extractionDraft(user)), promptChars)
      }
      record({ kind: 'fixed_text', path, model, detail: `messages=${messages.length}` })
      return chat(res, SCRIPT_TEXT, promptChars)
    })
  })

  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('假模型端口不可用')); return }
      resolveServer({ server, url: `http://${HOST}:${addr.port}/v1` })
    })
  })
}

/** 由真实 sourceText 计算 UTF-16 区间，保证证据 quote 与偏移严格一致。 */
function evidenceOf(text: string, quote: string): { start: number; end: number; quote: string } | null {
  const start = text.indexOf(quote)
  return start < 0 ? null : { start, end: start + quote.length, quote }
}

function extractionDraft(user: string): unknown {
  let sourceText = ''
  try {
    const parsed = JSON.parse(user) as { sourceText?: unknown }
    if (typeof parsed.sourceText === 'string') sourceText = parsed.sourceText
  } catch { /* 非预期输入 → 返回无变化草稿 */ }
  const facts: Array<{ topic: string; label: string; quote: string; channel: 'fact' | 'knowledge'; type: string; subjects: string[]; knower?: string; epistemic?: string }> = [
    { topic: 'injury', label: '受伤状态', quote: '甲受伤', channel: 'fact', type: 'state', subjects: ['jia'] },
    { topic: 'key', label: '钥匙归属', quote: '钥匙归甲', channel: 'fact', type: 'possession', subjects: ['jia'] },
    { topic: 'identity', label: '卧底身份认知', quote: '观众知道甲是卧底', channel: 'knowledge', type: 'state', subjects: ['jia', 'audience'], knower: 'audience', epistemic: 'knows' },
    { topic: 'suspicion', label: '乙的认知', quote: '乙尚不知甲是卧底', channel: 'knowledge', type: 'state', subjects: ['jia', 'yi'], knower: 'yi', epistemic: 'unaware' },
  ]
  const items = facts.flatMap((f, i) => {
    const evidence = evidenceOf(sourceText, f.quote)
    if (!evidence) return []
    return [{
      id: `i${i + 1}`, topicKey: f.topic, channel: f.channel, type: f.type, operation: 'set', subjects: f.subjects,
      value: f.quote, previous: null, evidence: [evidence], origin: 'extracted', editNote: '', included: true,
      ...(f.knower ? { knower: f.knower, epistemic: f.epistemic } : {}),
    }]
  })
  return {
    subjects: [
      { key: 'jia', label: '甲', entityId: null, aliases: [] },
      { key: 'yi', label: '乙', entityId: null, aliases: [] },
      { key: 'audience', label: '观众', entityId: null, aliases: [] },
    ],
    topics: facts.map((f) => ({ key: f.topic, label: f.label })),
    items,
    warnings: [],
    noChanges: items.length === 0,
  }
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && ALLOW_ENV.has(k.toUpperCase())) env[k] = v
  }
  return Object.assign(env, extra)
}

interface Running { child: ChildProcess; label: string; tail: string[] }

function spawnLogged(label: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const tail: string[] = []
  const keep = (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      tail.push(line)
      if (tail.length > 40) tail.shift()
      console.log(`[${label}] ${line}`)
    }
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  return { child, label, tail }
}

async function waitFor(url: string, timeoutMs: number, tail: () => string[]): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status < 500) return
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待 ${url} 超时\n${tail().join('\n')}`)
}

async function api(base: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}：${text.slice(0, 300)}`)
  return text ? (JSON.parse(text) as unknown) : null
}

interface SeedInfo { projectId: number; seriesId: number; episodeIds: number[]; runId: number; runStatus: string }

/** 只经产品 HTTP 端点铺样例：项目 → 三集剧 → 第1集完成一次剧本 run（假模型固定文本）。 */
async function seed(base: string, log: (msg: string) => void): Promise<SeedInfo> {
  const project = (await api(base, '/api/v1/projects', 'POST', {
    name: 'M70浏览器隔离项目', template_key: FIXTURE_TEMPLATE, brief: SCRIPT_TEXT,
  })) as { project: { id: number } }
  const projectId = project.project.id
  const series = (await api(base, `/api/v1/projects/${projectId}/series`, 'POST', {
    name: '隔离剧', total_episodes: 3,
  })) as { series: { id: number }; episodes: Array<{ id: number }> }
  const started = (await api(base, `/api/v1/projects/${projectId}/runs`, 'POST', {
    template_key: FIXTURE_TEMPLATE,
    input: { brief: SCRIPT_TEXT, episode_number: 1, with_continuity: false },
  })) as { run: { id: number } }
  const runId = started.run.id
  let runStatus = 'queued'
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const detail = (await api(base, `/api/v1/runs/${runId}`, 'GET')) as { run: { status: string; error?: string | null } }
    runStatus = detail.run.status
    if (['completed', 'failed', 'cancelled'].includes(runStatus)) {
      if (runStatus !== 'completed') throw new Error(`样例 run ${runId} 终态 ${runStatus}：${detail.run.error ?? '无错误详情'}`)
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (runStatus !== 'completed') throw new Error(`样例 run ${runId} 超时未终态（${runStatus}）`)
  log(`seed ok project=${projectId} series=${series.series.id} run=${runId}`)
  return { projectId, seriesId: series.series.id, episodeIds: series.episodes.map((e) => e.id), runId, runStatus }
}

async function main(): Promise<void> {
  assertUnconfiguredCheckout()
  const tempRoot = mkdtempSync(join(tmpdir(), 'm70-browser-'))
  const tempWorkspace = join(tempRoot, 'workspace')
  const tempData = join(tempRoot, 'data')
  mkdirSync(tempWorkspace, { recursive: true })
  mkdirSync(tempData, { recursive: true })
  copyTracked(tempRoot, ['workspace', 'apps/server/drizzle'])
  writeFileSync(join(tempWorkspace, 'templates', `${FIXTURE_TEMPLATE}.yaml`), `key: ${FIXTURE_TEMPLATE}
name: M70 隔离浏览器样例
version: 1
genre: drama_short
inputs:
  - { key: brief, label: 简报, kind: text, required: true }
  - { key: episode_number, label: 集号, kind: int, required: true }
  - { key: with_continuity, label: 连续性, kind: bool, default: false }
  - { key: continuity_context, label: 承接包, kind: files, required: false }
steps:
  - key: write_script
    action: ai_text
    title: 生成本集剧本
    inputs: {}
    params:
      continuity_role: episode_script
      prompt_inline: 仅使用隔离测试输入生成本集剧本。
      output_purpose: script
`, 'utf8')

  const [serverPort, webPort] = [await freePort(), await freePort()]
  const serverUrl = `http://${HOST}:${serverPort}`
  const webUrl = `http://${HOST}:${webPort}`
  const calls: LlmCall[] = []
  const stub = await startStub(join(tempRoot, 'llm-requests.jsonl'), calls)
  const stubUrl = stub.url

  const env = childEnv({
    CSTUDIO_ROOT: tempRoot,
    CSTUDIO_DATA: tempData,
    CSTUDIO_WORKSPACE: tempWorkspace,
    CSTUDIO_HOST: HOST,
    CSTUDIO_PORT: String(serverPort),
    CSTUDIO_WEB_PORT: String(webPort),
    CSTUDIO_LOG_LEVEL: 'info',
    AGENT_LLM_BASE_URL: stubUrl,
    AGENT_LLM_API_KEY: FIXTURE_API_KEY,
    AGENT_LLM_MODEL: FIXTURE_MODEL,
    DOTENV_CONFIG_QUIET: 'true',
    NO_UPDATE_NOTIFIER: '1',
  })

  const running: Running[] = []
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    cleaned = true
    for (const r of running.reverse()) {
      if (r.child.exitCode === null) {
        r.child.kill()
        await Promise.race([
          new Promise<void>((ok) => r.child.once('exit', () => ok())),
          new Promise<void>((ok) => setTimeout(ok, 5000)),
        ])
        if (r.child.exitCode === null) r.child.kill('SIGKILL')
      }
    }
    await new Promise<void>((ok) => { stub.server.close(() => ok()); stub.server.closeAllConnections() })
    if (process.env.M70_KEEP_FIXTURE !== '1') {
      try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 进程句柄延迟释放时保留目录 */ }
    }
  }
  const stop = (signal: string) => {
    console.log(`[fixture] ${signal} → closing`)
    void cleanup().finally(() => process.exit(0))
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  try {
    const server = spawnLogged('server', join(REPO, 'apps/server'),
      ['--import', './node_modules/tsx/dist/loader.mjs', 'src/index.ts'], env)
    running.push(server)
    await waitFor(`${serverUrl}/api/v1/projects`, 90_000, () => server.tail)

    const web = spawnLogged('web', join(REPO, 'apps/web'),
      ['node_modules/vite/bin/vite.js', '--host', HOST, '--port', String(webPort), '--strictPort'], env)
    running.push(web)
    await waitFor(webUrl, 60_000, () => web.tail)

    const wantSeed = !process.argv.includes('--no-seed')
    const seeded = wantSeed ? await seed(serverUrl, (m) => console.log(`[fixture] ${m}`)) : null
    const info = { serverUrl, webUrl, stubUrl, tempRoot, seed: seeded }
    writeFileSync(join(tempRoot, 'fixture.json'), JSON.stringify(info, null, 2), 'utf8')
    console.log(`M70_FIXTURE_READY ${JSON.stringify(info)}`)
    await new Promise<void>(() => { /* 保持运行，直到信号退出 */ })
  } catch (err) {
    console.error('[fixture] 启动失败', err)
    await cleanup()
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[fixture] fatal', err)
  process.exit(1)
})
