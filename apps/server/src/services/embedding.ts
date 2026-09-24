import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { env as trEnv, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { DATA_DIR } from '../env'
import { db } from '../db'
import { settings } from '../db/schema'

/**
 * 本地 embedding 服务（transformers.js + ONNX，默认 bge-small-zh-v1.5）。
 * 懒加载单例 + inflight 互斥；normalize 后余弦 = 点积（cosine 实现）。
 * 模型目录：data/models/{modelName}/（model:prepare 就绪：config.json + tokenizer.json + onnx/*.onnx）。
 */

const DEFAULT_MODEL = 'bge-small-zh-v1.5'
export const MODELS_ROOT = join(DATA_DIR, 'models')

let extractor: FeatureExtractionPipeline | null = null
let loading: Promise<FeatureExtractionPipeline> | null = null
let info: { modelName: string; dims: number } | null = null

/** 模型名解析：settings 表 key='embedding' JSON {model} → env CSTUDIO_EMBEDDING_MODEL → 默认 bge-small-zh-v1.5 */
export async function resolveModelName(): Promise<string> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, 'embedding')).limit(1)
    if (rows[0]) {
      const cfg = JSON.parse(rows[0].value) as { model?: string }
      if (cfg.model) return cfg.model
    }
  } catch { /* settings 表缺失/损坏 → 回退 */ }
  return process.env.CSTUDIO_EMBEDDING_MODEL ?? DEFAULT_MODEL
}

/** onnx 目录导出文件 → dtype 映射（transformers.js 文件名约定） */
function pickDtype(onnxDir: string): string | null {
  const files = readdirSync(onnxDir)
  if (files.includes('model_fp16.onnx')) return 'fp16'
  if (files.includes('model.onnx')) return 'fp32'
  if (files.includes('model_quantized.onnx')) return 'q8'
  if (files.includes('model_int8.onnx')) return 'int8'
  return null
}

/** 加载模型（单例；并发调用共享同一 inflight promise） */
export async function ensureEmbedder(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor
  if (loading) return loading // 并发初始化互斥（单 inflight promise）
  loading = (async () => {
    const modelName = await resolveModelName()
    const dir = join(MODELS_ROOT, modelName)
    const onnxDir = join(dir, 'onnx')
    if (!existsSync(onnxDir)) {
      throw new Error(`未找到 embedding 模型：请将模型置于 ${dir}（README「记忆与模型」有下载/复制说明；或运行 pnpm --filter @acs/server model:prepare）`)
    }
    const dtype = pickDtype(onnxDir)
    if (!dtype) throw new Error(`模型目录 ${onnxDir} 无可用 .onnx 导出（支持 model_fp16/model/model_quantized/model_int8）`)
    trEnv.allowRemoteModels = false
    trEnv.allowLocalModels = true
    trEnv.localModelPath = MODELS_ROOT.replace(/\\/g, '/') + '/'
    // @ts-expect-error pipeline 联合重载过复杂（同 Toonflow 参照实现）
    extractor = await pipeline('feature-extraction', modelName, { dtype })
    return extractor
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

/** 文本 → 向量（mean pooling + normalize；normalize 后余弦 = 点积） */
export async function embed(text: string): Promise<number[]> {
  const ex = await ensureEmbedder()
  const out = await ex(text, { pooling: 'mean', normalize: true })
  const vec = Array.from(out.data as Float32Array)
  const modelName = await resolveModelName()
  if (!info || info.modelName !== modelName || info.dims !== vec.length) {
    info = { modelName, dims: vec.length }
  }
  return vec
}

/** 余弦相似度（向量已 normalize → 等价点积） */
export function cosine(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** 模型状态（不触发加载；模型缺失也要能报 status）；dims 优先已加载实测，其次 config.json hidden_size */
export async function embeddingStatus(): Promise<{
  ready: boolean; modelDir: string; modelName: string; dims: number | null; error?: string
}> {
  const modelName = await resolveModelName()
  const dir = join(MODELS_ROOT, modelName)
  const onnxDir = join(dir, 'onnx')
  const onnxFiles = existsSync(onnxDir) ? readdirSync(onnxDir).filter((f) => f.endsWith('.onnx')) : []
  const ready = existsSync(join(dir, 'config.json')) && existsSync(join(dir, 'tokenizer.json')) && onnxFiles.length > 0
  let dims: number | null = info && info.modelName === modelName ? info.dims : null
  if (dims === null && ready) {
    try {
      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { hidden_size?: number }
      if (typeof cfg.hidden_size === 'number') dims = cfg.hidden_size
    } catch { /* config 不可读 → dims 保持 null */ }
  }
  return {
    ready,
    modelDir: dir,
    modelName,
    dims,
    error: ready ? undefined : `未找到 embedding 模型：请将模型置于 ${dir}（或运行 pnpm --filter @acs/server model:prepare）`,
  }
}
