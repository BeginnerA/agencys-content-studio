/**
 * 便携包打包脚本——把本项目打成「解压即用」的 Windows 便携版（给非技术用户分发）：
 *   pnpm package:portable                  # 全量：构建 web + deploy server + 组装 + 自检 + zip
 *   pnpm package:portable -- --no-zip      # 只出文件夹不压缩
 *   pnpm package:portable -- --no-model    # 不带 embedding 模型（记忆/模板推荐功能届时降级）
 *   pnpm package:portable -- --skip-web-build  # 复用现有 apps/web/dist（开发迭代用）
 *
 * 产物：dist-portable/百工工作室-便携版/ + 同名 .zip
 *
 * 布局（env.ts 的 ROOT 解析面向此结构：CSTUDIO_ROOT 显式指向包根）：
 *   启动.bat / launcher.mjs / 使用说明.txt / NOTICE-第三方组件.txt / NOTICES.txt
 *   runtime/node.exe                        ← 自带 Node 运行时（目标机器零安装）
 *   apps/server/{src, drizzle, node_modules, package.json}   ← pnpm deploy --prod 产物（hoisted 真实文件）
 *   apps/web/dist/                          ← 前端构建产物（单端口静态托管）
 *   data/models/…                           ← 本地 embedding 模型（可选）
 *   workspace/{templates,prompts,compliance} ← 出厂资产（brand/projects/logs 运行期自建）
 *
 * 安全红线（脚本强制，防把个人数据发给外人）：
 *   1. data/secrets.json / .env / studio.db / workspace/projects|logs|brand 绝不入包（存在即 fail）；
 *   2. 泄漏扫描：把源 secrets.json 与 .env 里的真实密钥值当探针，全包文本文件命中即 fail；
 *   3. junction/symlink 审计：node_modules 必须是真实文件（pnpm 默认 isolated 布局换机器会断，
 *      故 deploy 强制 --config.node-linker=hoisted）。
 * 自检（真实拉起包内服务）：health(db+ffmpeg) / 模板清单 / 首页 SPA / embedding 就绪与实跑（ONNX 原生链路）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根：cwd 向上找 pnpm-workspace.yaml（与 src/env.resolveRoot 同款，但刻意不读 CSTUDIO_ROOT——
 *  打包的 data/workspace/web-dist 必须锚定仓库实态，外部环境变量污染不能带偏） */
function resolveRepoRoot(): string {
  let dir = process.cwd()
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const ROOT = resolveRepoRoot()
const PORTABLE_SRC = join(HERE, 'portable')
const DIST_DIR = join(ROOT, 'dist-portable')
const PKG_DIR = join(DIST_DIR, '百工工作室-便携版')
const STAGE_SERVER = join(DIST_DIR, '.stage-server') // ASCII 名：外部命令（pnpm/tar）不碰中文路径
const EMBED_MODEL = process.env.CSTUDIO_EMBEDDING_MODEL ?? 'bge-small-zh-v1.5'

const args = new Set(process.argv.slice(2).map((a) => a.toLowerCase()))
const WANT_ZIP = !args.has('--no-zip')
const WANT_MODEL = !args.has('--no-model')
const SKIP_WEB_BUILD = args.has('--skip-web-build')

/** 二进制扩展名：泄漏扫描跳过（密钥不可能出现在里面，读文本也没意义） */
const BINARY_EXTS = new Set(['.exe', '.dll', '.node', '.wasm', '.onnx', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.zip', '.gz', '.mp4', '.mp3', '.wav', '.pak', '.bin', '.dylib', '.so'])

let failed = false
function fail(msg: string): void {
  console.error(`  ✗ ${msg}`)
  failed = true
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`)
}
function step(title: string): void {
  console.log(`\n== ${title} ==`)
}

/** 目录体积（MB，一位小数） */
function sizeMB(dir: string): number {
  let total = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) total += statSync(p).size
    }
  }
  walk(dir)
  return total / 1024 / 1024
}

/** 递归找 junction/symlink（lstat 视角；Windows junction 也算 symlink） */
function findLinks(dir: string): string[] {
  const hits: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) { hits.push(join(d, e.name)); continue }
      if (e.isDirectory()) walk(join(d, e.name))
    }
  }
  walk(dir)
  return hits
}

/** Windows 下 spawn 一个 .cmd（pnpm）——cmd.exe 直呼，参数不经 shell 解析 */
function runCmd(parts: string[], opts: { cwd: string }): number {
  const r = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : parts[0]!,
    process.platform === 'win32' ? ['/c', ...parts] : parts.slice(1),
    { cwd: opts.cwd, stdio: 'inherit' },
  )
  return r.status ?? 1
}

// ---------- [1] 前端构建 ----------
function buildWeb(): void {
  step('构建前端（apps/web）')
  if (SKIP_WEB_BUILD) {
    if (!existsSync(join(ROOT, 'apps', 'web', 'dist', 'index.html'))) return fail('--skip-web-build 但 apps/web/dist 不存在')
    return ok('跳过构建（复用现有 dist）')
  }
  const code = runCmd(['pnpm', '--filter', '@acs/web', 'build'], { cwd: ROOT })
  if (code !== 0) return fail(`pnpm --filter @acs/web build 退出码 ${code}`)
  ok('vite build 完成')
}

// ---------- [2] 服务端 deploy（自包含 node_modules）----------
function deployServer(): void {
  step('部署服务端依赖（pnpm deploy --prod，hoisted 真实文件布局）')
  rmSync(STAGE_SERVER, { recursive: true, force: true })
  const code = runCmd(
    ['pnpm', '--filter', '@acs/server', 'deploy', '--prod', '--config.node-linker=hoisted', STAGE_SERVER],
    { cwd: ROOT },
  )
  if (code !== 0) return fail(`pnpm deploy 退出码 ${code}`)
  // deploy 产物落位 + 断言关键文件
  mkdirSync(join(PKG_DIR, 'apps', 'server'), { recursive: true })
  for (const item of ['src', 'node_modules', 'drizzle', 'package.json']) {
    renameSync(join(STAGE_SERVER, item), join(PKG_DIR, 'apps', 'server', item))
  }
  // deploy 附带但运行期无用的东西（探针脚本、构建配置、workspace 占位）
  for (const junk of ['scripts', 'tsconfig.json', 'drizzle.config.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '_db_idempotent.cjs', '_db_inspect.cjs', 'workspace']) {
    rmSync(join(PKG_DIR, 'apps', 'server', junk), { recursive: true, force: true })
  }
  const serverDir = join(PKG_DIR, 'apps', 'server')
  const mustExist = [
    ['src/index.ts', '服务端入口'],
    ['drizzle/meta/_journal.json', '迁移 journal（首次自动建库依赖）'],
    ['node_modules/tsx/package.json', 'tsx 运行器'],
    ['node_modules/ffmpeg-static/ffmpeg.exe', '内置 ffmpeg'],
  ] as const
  for (const [rel, why] of mustExist) {
    if (!existsSync(join(serverDir, rel))) fail(`缺 ${rel}（${why}）—— deploy 产物不完整`)
  }
  if (!failed) ok('deploy 产物完整（入口/迁移/tsx/ffmpeg）')
}

// ---------- [3] node_modules 瘦身（Windows x64 便携面）----------
function slimNodeModules(): void {
  step('瘦身 node_modules（只留 win32/x64 原生二进制 + 移除不加载的包）')
  const nm = join(PKG_DIR, 'apps', 'server', 'node_modules')
  const before = sizeMB(nm)
  const removeDirs = [
    // ffprobe-static：全平台二进制 → 只留 win32/x64（index.js 按 platform/arch 选路径）
    'ffprobe-static/bin/darwin', 'ffprobe-static/bin/linux', 'ffprobe-static/bin/win32/ia32', 'ffprobe-static/bin/win32/arm64',
    // onnxruntime-node：bin/napi-v3 下全平台 → 只留 win32/x64
    'onnxruntime-node/bin/napi-v3/darwin', 'onnxruntime-node/bin/napi-v3/linux', 'onnxruntime-node/bin/napi-v3/win32/arm64',
    // drizzle-orm 的 optional 依赖：本项目用 libsql 方言永不加载（且 allowBuilds 禁其构建，无 binding）
    'better-sqlite3',
    // transformers.js 的 wasm 后端：Node 下走 onnxruntime-node（冒烟实跑 embedding 验证）
    'onnxruntime-web',
  ]
  for (const rel of removeDirs) rmSync(join(nm, rel), { recursive: true, force: true })
  const after = sizeMB(nm)
  ok(`node_modules ${before.toFixed(1)} MB → ${after.toFixed(1)} MB（- ${(before - after).toFixed(1)} MB）`)
}

// ---------- [4] 组装运行面 ----------
function assemble(): void {
  step('组装运行面（前端产物 / 出厂 workspace / 模型 / Node 运行时 / 启动文件）')
  // 前端 dist
  mkdirSync(join(PKG_DIR, 'apps', 'web'), { recursive: true })
  cpSync(join(ROOT, 'apps', 'web', 'dist'), join(PKG_DIR, 'apps', 'web', 'dist'), { recursive: true })
  // 出厂 workspace 资产（projects/logs/brand 运行期自建，绝不入包）
  for (const sub of ['templates', 'prompts', 'compliance']) {
    const src = join(ROOT, 'workspace', sub)
    if (!existsSync(src)) return fail(`出厂资产缺失：workspace/${sub}`)
    cpSync(src, join(PKG_DIR, 'workspace', sub), { recursive: true })
  }
  // embedding 模型（可选）
  if (WANT_MODEL) {
    const modelSrc = join(ROOT, 'data', 'models', EMBED_MODEL)
    if (!existsSync(modelSrc)) return fail(`模型目录不存在：${modelSrc}（先跑 model:prepare -- --download，或 --no-model 跳过）`)
    cpSync(modelSrc, join(PKG_DIR, 'data', 'models', EMBED_MODEL), { recursive: true })
    ok(`模型已入包：${EMBED_MODEL}`)
  } else {
    ok('按参数跳过模型（记忆/模板推荐功能将降级）')
  }
  // Node 运行时
  mkdirSync(join(PKG_DIR, 'runtime'), { recursive: true })
  copyFileSync(process.execPath, join(PKG_DIR, 'runtime', 'node.exe'))
  // 启动面四件 + 项目既有声明
  copyFileSync(join(PORTABLE_SRC, 'launcher.mjs'), join(PKG_DIR, 'launcher.mjs'))
  copyFileSync(join(PORTABLE_SRC, 'start.bat'), join(PKG_DIR, '启动.bat'))
  copyFileSync(join(PORTABLE_SRC, '使用说明.txt'), join(PKG_DIR, '使用说明.txt'))
  copyFileSync(join(PORTABLE_SRC, 'NOTICE-第三方组件.txt'), join(PKG_DIR, 'NOTICE-第三方组件.txt'))
  if (existsSync(join(ROOT, 'NOTICES.txt'))) copyFileSync(join(ROOT, 'NOTICES.txt'), join(PKG_DIR, 'NOTICES.txt'))
  ok(`启动面就绪（node ${process.version}）`)
}

// ---------- [5] 泄漏防护（三重）----------
function leakGuard(): void {
  step('泄漏防护（密钥不入包）')
  // a) 运行期数据文件绝不在包里（组装是白名单式，此处是双保险断言）
  for (const rel of ['data/secrets.json', '.env', 'data/studio.db', 'data/studio.db-wal', 'data/studio.db-shm', 'workspace/projects', 'workspace/logs', 'workspace/brand']) {
    if (existsSync(join(PKG_DIR, rel))) fail(`包内出现禁入文件：${rel}`)
  }
  if (failed) return
  // b) 密钥探针扫描：源 secrets.json 与 .env 里的真实值 → 全包文本文件检索
  const needles: string[] = []
  const secretsFile = join(ROOT, 'data', 'secrets.json')
  if (existsSync(secretsFile)) {
    try {
      const vals = Object.values(JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>)
      needles.push(...vals.filter((v) => v && v.length >= 12))
    } catch { /* 解析失败不阻塞（扫描面兜底） */ }
  }
  const envFile = join(ROOT, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim())
      if (!m || !m[2] || m[2].startsWith('http')) continue
      // 只取疑似密钥形态：纯配置值（模型名/端口等短串）不入探针——实证：deepseek-flash 曾致源码默认模型名 4 处误报
      const looksLikeKey = m[2].length >= 20 || /^(sk-|sk_|ark-|AQ\.|api-key|Bearer )/.test(m[2])
      if (looksLikeKey) needles.push(m[2])
    }
  }
  let scanned = 0
  let hits: string[] = []
  if (needles.length > 0) {
    const files = readdirSync(PKG_DIR, { recursive: true })
    for (const f of files) {
      const p = join(PKG_DIR, f as string)
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue
      if (BINARY_EXTS.has(/\.[a-z0-9]+$/i.exec(p)?.[0]?.toLowerCase() ?? '')) continue
      let text: string
      try { text = readFileSync(p, 'utf8') } catch { continue }
      scanned++
      if (needles.some((n) => text.includes(n))) hits.push(p)
    }
    if (hits.length > 0) {
      fail(`密钥泄漏命中 ${hits.length} 个文件：${hits.slice(0, 5).join(' ; ')}…`)
    } else {
      ok(`密钥探针扫描通过（${needles.length} 个密钥值 × ${scanned} 个文本文件，0 命中）`)
    }
  } else {
    ok('源无 secrets.json/.env 密钥值，跳过探针扫描（仍受 a) 断言保护）')
  }
  // c) junction/symlink 审计（换机器/换路径会断的链接一律 fail）
  const links = findLinks(PKG_DIR)
  if (links.length > 0) fail(`发现 ${links.length} 个链接（换机即断）：${links.slice(0, 3).join(' ; ')}…`)
  else ok('链接审计通过：包内全部为真实文件')
}

// ---------- [6] 冒烟（真实拉起包内服务）----------
async function smoke(): Promise<void> {
  step('冒烟自检（用包内 runtime/node.exe 真实拉起服务）')
  const port = 39000 + Math.floor(Math.random() * 999)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(join(PKG_DIR, 'runtime', 'node.exe'), ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(PKG_DIR, 'apps', 'server'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CSTUDIO_ROOT: PKG_DIR, CSTUDIO_HOST: '127.0.0.1', CSTUDIO_PORT: String(port) },
  })
  const out: string[] = []
  const keep = (d: Buffer): void => { out.push(d.toString('utf8')); if (out.length > 200) out.shift() }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const killTree = (): void => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  }
  const get = async (path: string): Promise<{ status: number; body: string }> => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
      return { status: res.status, body: await res.text() }
    } catch {
      return { status: 0, body: '' }
    }
  }
  try {
    // 轮询 health（首次启动要建库+种子）
    let health: { status: number; body: string } = { status: 0, body: '' }
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) break
      health = await get('/api/v1/health')
      if (health.status === 200) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (health.status !== 200) {
      fail(`health 未就绪（子进程退出码 ${child.exitCode}）`)
      console.error(`  服务端日志尾部：\n${out.slice(-20).map((l) => `    ${l}`).join('\n')}`)
      return
    }
    const hj = JSON.parse(health.body) as { db?: string; ffmpeg?: string }
    if (hj.db !== 'ok') fail(`health.db=${hj.db}`)
    else ok('health：db ok（首次自动建库成功）')
    if (hj.ffmpeg !== 'ok') fail(`health.ffmpeg=${hj.ffmpeg}（内置 ffmpeg 不可用）`)
    else ok('health：ffmpeg ok（包内 ffmpeg-static 实测可用）')

    // 模板清单（出厂资产 + loader 全链路）
    const templates = await get('/api/v1/templates')
    if (templates.status !== 200) fail(`GET /api/v1/templates → ${templates.status}`)
    else {
      const n = (JSON.parse(templates.body) as { items?: unknown[] }).items?.length ?? 0
      if (n < 15) fail(`模板清单仅 ${n} 项（出厂 18+，workspace 资产疑缺失）`)
      else ok(`模板清单 ${n} 项`)
    }

    // 首页 SPA（单端口静态托管）
    const idx = await get('/')
    if (idx.status !== 200 || !idx.body.includes('<!doctype html>') || !idx.body.includes('id="app"')) {
      fail(`GET / 异常（status=${idx.status}）`)
    } else ok('首页 index.html 托管正常')

    // embedding：就绪 + 实跑（ONNX 原生链路 + onnxruntime-web 删除安全性）
    if (WANT_MODEL) {
      const st = await get('/api/v1/memories/status')
      const sj = st.status === 200 ? (JSON.parse(st.body) as { ready?: boolean; dims?: number }) : {}
      if (sj.ready !== true) fail(`memories/status ready=${sj.ready}（模型未就绪）`)
      else ok(`embedding 模型就绪（dims=${sj.dims}）`)
      const post = await fetch(`${base}/api/v1/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '便携包冒烟', scope: 'global', type: 'note', name: 'smoke' }),
        signal: AbortSignal.timeout(120_000),
      })
      if (post.status !== 201) {
        fail(`POST /api/v1/memories → ${post.status}（ONNX 实跑失败）`)
      } else {
        const after = JSON.parse((await get('/api/v1/memories/status')).body) as { missingEmbedding?: number }
        if (after.missingEmbedding !== 0) fail(`实跑后 missingEmbedding=${after.missingEmbedding}`)
        else ok('embedding 实跑成功（onnxruntime-node 原生链路验证通过）')
      }
    } else {
      ok('未带模型，跳过 embedding 实跑')
    }
  } finally {
    killTree()
    await new Promise((r) => setTimeout(r, 1500))
    // 清掉冒烟运行期产物，保持分发面干净（下次启动自动重建；brand 同理——出厂态不含任何运行期目录）
    for (const rel of ['data/studio.db', 'data/studio.db-wal', 'data/studio.db-shm', 'workspace/logs', 'workspace/projects', 'workspace/brand']) {
      rmSync(join(PKG_DIR, rel), { recursive: true, force: true })
    }
    if (existsSync(join(PKG_DIR, 'data', 'secrets.json'))) fail('冒烟后出现 data/secrets.json（不该发生）')
  }
}

// ---------- [7] zip ----------
function makeZip(): void {
  step('压缩分发包')
  const zipPath = join(DIST_DIR, `百工工作室-便携版-v${pkgVersion()}.zip`)
  rmSync(zipPath, { force: true })
  // bsdtar（Win10+ 自带）：-a 按扩展名选 zip 格式；中文文件名走 UTF-8 flag
  const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', DIST_DIR, '百工工作室-便携版'], { stdio: 'ignore' })
  if (tar.status !== 0) {
    console.log('  bsdtar 失败，改用 PowerShell Compress-Archive…')
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Compress-Archive -LiteralPath '${PKG_DIR}' -DestinationPath '${zipPath}' -Force`], { stdio: 'ignore' })
    if (ps.status !== 0) return fail(`zip 失败（tar=${tar.status}，powershell=${ps.status}）`)
  }
  ok(`${zipPath}（${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB）`)
}

function pkgVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// ---------- main ----------
async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('本脚本当前仅面向 Windows 便携包（node.exe、平台二进制瘦身均为 win32/x64 假设）')
    process.exitCode = 2
    return
  }
  // ROOT 合法性断言：仓库根必须可验证（resolveRepoRoot 已忽略 CSTUDIO_ROOT；此断言防 cwd 异常）
  if (!existsSync(join(ROOT, 'pnpm-workspace.yaml'))) {
    console.error(`ROOT 解析异常：${ROOT} 下无 pnpm-workspace.yaml（脚本只应在仓库内运行）`)
    process.exitCode = 2
    return
  }
  mkdirSync(DIST_DIR, { recursive: true })
  rmSync(PKG_DIR, { recursive: true, force: true })
  rmSync(STAGE_SERVER, { recursive: true, force: true })

  buildWeb()
  if (failed) return finish()
  deployServer()
  if (failed) return finish()
  slimNodeModules()
  assemble()
  if (failed) return finish()
  leakGuard()
  if (failed) return finish()
  await smoke()
  if (failed) return finish()
  if (WANT_ZIP) makeZip()
  rmSync(STAGE_SERVER, { recursive: true, force: true })

  finish()
  console.log(`
分发面文件清单（给用户的全部入口）：
  启动.bat            双击启动（黑窗=运行状态，关窗=退出）
  launcher.mjs        启动器逻辑（端口探测/拉起服务/开浏览器）
  使用说明.txt        非技术用户上手三步 + API Key 引导
  NOTICE-第三方组件.txt / NOTICES.txt   许可声明
数据面（用户运行期生成，包内为空）：data/ 与 workspace/{projects,logs,brand}
`)
}

function finish(): void {
  step('汇总')
  if (failed) {
    console.error('  ✗ 打包失败——见上方 ✗ 项；包不可分发')
    process.exitCode = 1
    return
  }
  const parts: Array<[string, string]> = [
    ['runtime/node.exe + 启动面', join(PKG_DIR, 'runtime')],
    ['apps/server（源码+依赖+迁移）', join(PKG_DIR, 'apps', 'server')],
    ['apps/web/dist（前端）', join(PKG_DIR, 'apps', 'web')],
    ['data/models（embedding）', join(PKG_DIR, 'data')],
    ['workspace 出厂资产', join(PKG_DIR, 'workspace')],
  ]
  for (const [label, dir] of parts) {
    if (existsSync(dir)) console.log(`  · ${label}: ${sizeMB(dir).toFixed(1)} MB`)
  }
  console.log(`  · 包总体积: ${sizeMB(PKG_DIR).toFixed(1)} MB`)
  ok(`便携包就绪：${PKG_DIR}`)
}

main().catch((err) => {
  console.error(`打包脚本异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exitCode = 1
})
