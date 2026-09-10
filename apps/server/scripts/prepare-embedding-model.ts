/**
 * M3 模型就绪脚本——准备本地 embedding 模型（默认 bge-small-zh-v1.5，Xenova ONNX 导出）：
 *   pnpm --filter @acs/server model:prepare                     # 检查就绪；未就绪打印获取指引（退出码 0/2）
 *   pnpm --filter @acs/server model:prepare -- --download       # 逐文件下载（hf-mirror 优先，官方回退；退出码 0/1）
 *   pnpm --filter @acs/server model:prepare -- --from-toonflow  # 兜底：复制 Toonflow 的 all-MiniLM-L6-v2 到 data/models/
 *
 * 只做文件系统/网络操作（不写库、不启动服务）；目标目录 data/models/{modelName}/
 * 模型名解析：环境变量 CSTUDIO_EMBEDDING_MODEL（.env 亦可）→ 默认 bge-small-zh-v1.5。
 * 退出码：0 = READY；1 = 操作失败；2 = 未就绪（已打印获取指引）。
 */
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, dirname, join } from 'node:path'
import { DATA_DIR, ROOT } from '../src/env'

const DEFAULT_MODEL = 'bge-small-zh-v1.5'
const MODEL_NAME = process.env.CSTUDIO_EMBEDDING_MODEL ?? DEFAULT_MODEL
const MODEL_DIR = join(DATA_DIR, 'models', MODEL_NAME)
const HF_REPO = 'Xenova/bge-small-zh-v1.5'
const SOURCES = [
  `https://hf-mirror.com/${HF_REPO}/resolve/main`,
  `https://huggingface.co/${HF_REPO}/resolve/main`,
]
/** 完整文件清单（按需下载/检查；就绪判定见 checkReady） */
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_fp16.onnx',
]

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

/** 就绪判定：config.json + tokenizer.json + onnx/ 下任一 .onnx（宽松——量化档亦可）；missing 用于明细展示 */
function checkReady(): { ready: boolean; onnxFiles: string[]; missing: string[] } {
  const onnxDir = join(MODEL_DIR, 'onnx')
  const onnxFiles = existsSync(onnxDir) ? readdirSync(onnxDir).filter((f) => f.endsWith('.onnx')) : []
  const ready = existsSync(join(MODEL_DIR, 'config.json')) && existsSync(join(MODEL_DIR, 'tokenizer.json')) && onnxFiles.length > 0
  const missing = FILES.filter((f) => !existsSync(join(MODEL_DIR, f)))
  return { ready, onnxFiles, missing }
}

/** READY 明细：关键文件清单 + 大小 */
function printReadyDetail(onnxFiles: string[]): void {
  const rows: string[] = []
  for (const f of FILES) {
    if (f.startsWith('onnx/')) continue
    const p = join(MODEL_DIR, f)
    if (existsSync(p)) rows.push(`  - ${f}  ${fmtMB(statSync(p).size)} MB`)
  }
  for (const f of onnxFiles) {
    const p = join(MODEL_DIR, 'onnx', f)
    rows.push(`  - onnx/${f}  ${fmtMB(statSync(p).size)} MB`)
  }
  console.log(rows.join('\n'))
}

/** 未就绪指引（退出码 2） */
function printGuide(missing: string[]): void {
  console.log(`未就绪：${MODEL_DIR}`)
  if (missing.length) console.log(`缺失文件：${missing.join(' / ')}`)
  console.log('获取方式（二选一）：')
  console.log(`A) 自动下载：pnpm --filter @acs/server model:prepare -- --download`)
  console.log(`B) 手动放置：从下列任一源逐文件下载并保持相对路径，放入 ${MODEL_DIR}/`)
  for (const base of SOURCES) console.log(`   源：${base}/{file}`)
  for (const f of FILES) console.log(`   - ${f}`)
  console.log(`C) 英文兜底（离线）：pnpm --filter @acs/server model:prepare -- --from-toonflow`)
}

/** 单文件下载（.part 临时文件 → 成功后 rename；带 Content-Length 进度） */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  let got = 0
  let lastPct = -1
  try {
    const stream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      out.write(buf)
      got += buf.length
      const pct = total > 0 ? Math.floor((got / total) * 100) : -1
      if (pct !== lastPct) {
        lastPct = pct
        const tail = total > 0 ? `${pct}% (${fmtMB(got)}/${fmtMB(total)} MB)` : `${fmtMB(got)} MB`
        process.stdout.write(`\r  ${basename(dest)}  ${tail}   `)
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
    process.stdout.write('\n')
    renameSync(tmp, dest)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** 逐文件下载：跳过已存在；源按镜像→官方顺序回退 */
async function downloadAll(): Promise<void> {
  for (const file of FILES) {
    const dest = join(MODEL_DIR, file)
    if (existsSync(dest)) {
      console.log(`  已存在，跳过：${file}`)
      continue
    }
    let ok = false
    let lastErr = ''
    for (const base of SOURCES) {
      try {
        await downloadFile(`${base}/${file}`, dest)
        ok = true
        break
      } catch (e) {
        lastErr = String(e)
      }
    }
    if (!ok) throw new Error(`下载失败：${file}（源均不可达：${lastErr}）`)
  }
}

/** 兜底：复制 Toonflow 的 all-MiniLM-L6-v2 */
function copyFromToonflow(explicit?: string): void {
  const src = explicit ? explicit : join(ROOT, '..', 'Toonflow-app', 'data', 'models', 'all-MiniLM-L6-v2')
  if (!existsSync(src)) throw new Error(`源目录不存在：${src}（可用 --from-toonflow <路径> 显式指定）`)
  const dest = join(DATA_DIR, 'models', 'all-MiniLM-L6-v2')
  cpSync(src, dest, { recursive: true })
  console.log(`已复制：${src}\n     → ${dest}`)
  console.log('提示：复制的是英文兜底模型（all-MiniLM-L6-v2）。启用方式：settings 表 key=embedding 设 {"model":"all-MiniLM-L6-v2"}，或环境变量 CSTUDIO_EMBEDDING_MODEL=all-MiniLM-L6-v2')
  console.log('如需中文效果：pnpm --filter @acs/server model:prepare -- --download（bge-small-zh-v1.5）')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const fromIdx = args.indexOf('--from-toonflow')

  if (fromIdx >= 0) {
    copyFromToonflow(args[fromIdx + 1])
    return
  }

  const before = checkReady()
  if (before.ready) {
    console.log(`READY  ${MODEL_DIR}`)
    printReadyDetail(before.onnxFiles)
    return
  }

  if (args.includes('--download')) {
    console.log(`下载 bge-small-zh-v1.5（Xenova ONNX 导出）→ ${MODEL_DIR}`)
    await downloadAll()
    const after = checkReady()
    if (!after.ready) throw new Error(`下载完成但就绪判定未通过（缺失：${after.missing.join(' / ')}）`)
    console.log(`READY  ${MODEL_DIR}`)
    printReadyDetail(after.onnxFiles)
    return
  }

  printGuide(before.missing)
  process.exitCode = 2
}

main().catch((e) => {
  console.error(`失败：${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
