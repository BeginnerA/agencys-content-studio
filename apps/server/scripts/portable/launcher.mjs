/**
 * 便携包启动器（分发面唯一可执行入口；纯 Node，无任何依赖）。
 *
 * 职责：定位包根 → 选端口（已在跑则直接开浏览器）→ 以子进程拉起服务端（tsx 直跑源码）
 * → 轮询健康检查 → 打开默认浏览器 → 挂起等待服务退出。
 * 服务端路径/端口约定见 env.ts：CSTUDIO_ROOT 显式指定包根，避免 cwd 依赖。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(ROOT, 'apps', 'server')
const PORT_BASE = 3001
const PORT_MAX_TRY = 15
const HEALTH_TIMEOUT_MS = 120_000

/** 包内自带 node：不存在则退回 PATH（开发者场景） */
function resolveNodeExe() {
  const bundled = join(ROOT, 'runtime', 'node.exe')
  if (existsSync(bundled)) return bundled
  return 'node'
}

async function fetchJson(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 端口上是否已跑着本应用（health 返回 ok:true 才算） */
async function isOurApp(port) {
  const j = await fetchJson(`http://127.0.0.1:${port}/api/v1/health`)
  return !!j && typeof j === 'object' && j.ok === true
}

/** 端口是否空闲（无任何监听） */
function isPortFree(port) {
  const r = spawnSync(process.execPath, ['-e', `
    const net = require('net')
    const s = net.createServer()
    s.once('error', () => process.exit(1))
    s.listen(${port}, '127.0.0.1', () => { s.close(() => process.exit(0)) })
  `], { timeout: 5000 })
  return r.status === 0
}

async function pickPort() {
  for (let i = 0; i < PORT_MAX_TRY; i++) {
    const port = PORT_BASE + i
    if (await isOurApp(port)) return -port // 负数 = 已在运行
    if (isPortFree(port)) return port
  }
  return null
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', url], { shell: false })
  } else {
    for (const opener of ['xdg-open', 'open']) {
      try { spawnSync(opener, [url], { stdio: 'ignore' }); break } catch { /* 试下一个 */ }
    }
  }
}

function banner(url) {
  const line = '='.repeat(56)
  console.log('')
  console.log(line)
  console.log('  百工工作室 已启动')
  console.log(`  浏览器没有自动打开的话，请手动访问：${url}`)
  console.log('')
  console.log('  · 本窗口是程序运行窗口，使用期间请不要关闭')
  console.log('  · 想退出程序：直接关闭本窗口即可')
  console.log('  · 首次使用：进入网页后打开「AI 配置」，填入你的 API Key')
  console.log(line)
  console.log('')
}

async function main() {
  if (!existsSync(join(SERVER_DIR, 'src', 'index.ts'))) {
    console.error(`[启动失败] 未找到程序主体：${SERVER_DIR}\\src\\index.ts（包不完整，请重新解压）`)
    process.exit(1)
  }
  const nodeExe = resolveNodeExe()

  const picked = await pickPort()
  if (picked === null) {
    console.error(`[启动失败] ${PORT_BASE}~${PORT_BASE + PORT_MAX_TRY - 1} 端口都被占用，无法启动。请关闭占用这些端口的程序后重试。`)
    process.exit(1)
  }
  if (picked < 0) {
    const url = `http://127.0.0.1:${-picked}`
    console.log('检测到百工工作室已在运行，直接打开浏览器…')
    openBrowser(url)
    process.exit(0)
  }
  const port = picked

  console.log('正在启动（首次启动需要初始化数据，可能需要 10~60 秒）…')
  const child = spawn(
    nodeExe,
    ['--import', 'tsx', 'src/index.ts'],
    {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CSTUDIO_ROOT: ROOT,
        CSTUDIO_HOST: '127.0.0.1',
        CSTUDIO_PORT: String(port),
      },
    },
  )

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break // 进程已死，跳出等 health
    if (await isOurApp(port)) { ready = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (ready) {
    banner(url)
    openBrowser(url)
    // 挂起直到服务进程退出（用户关窗/Ctrl+C）；转发 Ctrl+C 让服务端走优雅停机
    process.on('SIGINT', () => { child.kill('SIGINT') })
    const code = await new Promise((resolve) => {
      child.once('exit', (c) => resolve(c))
      process.on('SIGINT', () => resolve(null))
    })
    process.exit(code ?? 0)
  }

  // 未就绪：进程还活着但 health 超时，或进程已退（错误已由继承 stdio 打到本窗口）
  if (child.exitCode === null) {
    console.error(`[启动异常] 服务进程仍在运行但 ${HEALTH_TIMEOUT_MS / 1000} 秒内未就绪。请把本窗口内容截图反馈。`)
    child.kill('SIGINT')
  } else {
    console.error(`[启动失败] 服务进程已退出（退出码 ${child.exitCode}）。请把本窗口内容截图反馈。`)
  }
  process.exit(1)
}

main().catch((err) => {
  console.error(`[启动失败] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
