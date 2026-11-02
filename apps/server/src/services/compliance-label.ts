/**
 * AIGC 合规标识服务：
 * - 隐式标识国标六字段（GB 45438-2025 /《标识办法》第五条）：Label/ContentProducer/ProduceID/ReservedCode1/ContentPropagator/PropagateID
 * - 载体：PNG tEXt（纯 Node chunk 插入）、JPEG APP1（纯 Node 段插入）、视频/音频容器（ffmpeg -c copy 重封装）
 * - 红线：隐式标识不可关；失败旁路不阻断（返回 ok:false，调用方 warn + tags 标记）；
 *   纯函数探针直测；绝不重新编码图像像素数据（PNG/JPEG 只做字节级段插入）
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { createLogger } from '../logger'
import { resolveFfmpeg } from './ffmpeg'

const log = createLogger('compliance-label')

export const AIGC_META_KEY = 'AIGC'

/** 国标六字段元数据（顺序即国标字段序） */
export interface AigcMeta {
  Label: '1'
  ContentProducer: string
  ProduceID: string
  ReservedCode1: string
  ContentPropagator: string
  PropagateID: string
}

/** 产国标六字段 JSON（纯函数；producer 空值兜底「个人创作者」；produceId 非空透传生成期记录，缺省生成新 UUID） */
export function aigcMetadata(opts: { producer: string; contentPropagator?: string; propagateId?: string; produceId?: string }): {
  json: string
  produceId: string
  meta: AigcMeta
} {
  const meta: AigcMeta = {
    Label: '1',
    ContentProducer: opts.producer?.trim() || '个人创作者',
    ProduceID: opts.produceId?.trim() || randomUUID(),
    ReservedCode1: '',
    ContentPropagator: opts.contentPropagator?.trim() ?? '',
    PropagateID: opts.propagateId?.trim() ?? '',
  }
  return { json: JSON.stringify(meta), produceId: meta.ProduceID, meta }
}

/** PNG tEXt 块插入（IHDR 之后；keyword AIGC\0 + JSON 值；CRC32 用 zlib.crc32（Node≥22.2）；非 PNG / IHDR 块头不符 → null） */
export function insertPngText(png: Buffer, metaJson: string): Buffer | null {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) return null
  // 首块廉价校验：长度域 13 + 类型域 'IHDR'（插入点假设首块即 IHDR，防结构异常输入误插损坏文件）
  if (png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  const data = Buffer.concat([Buffer.from(`${AIGC_META_KEY}\0`, 'latin1'), Buffer.from(metaJson, 'utf8')])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
  const at = 8 + (8 + 13 + 4) // 签名 + IHDR 块
  const out = Buffer.alloc(png.length + chunk.length)
  png.copy(out, 0, 0, at)
  chunk.copy(out, at)
  png.copy(out, at + chunk.length, at)
  return out
}

/** JPEG APP1 段插入（跳过既有 APP0 后插入 `AIGC\0` + JSON；长度字段大端；非 SOI/超 64KB → null） */
export function insertJpegApp1(jpeg: Buffer, metaJson: string): Buffer | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null
  const payload = Buffer.concat([Buffer.from(`${AIGC_META_KEY}\0`, 'latin1'), Buffer.from(metaJson, 'utf8')])
  if (payload.length + 2 > 0xffff) return null
  // 插入点：SOI 之后、跳过连续 APP0（JFIF）段——保持 APP0 先于 APP1 的惯例
  let at = 2
  while (jpeg[at] === 0xff && jpeg[at + 1] === 0xe0) {
    if (at + 4 > jpeg.length) return null // 段头截断（标记 + 长度不足 4 字节）
    const segLen = jpeg.readUInt16BE(at + 2)
    if (segLen < 2 || at + 2 + segLen > jpeg.length) return null // 段长声明越界
    at += 2 + segLen
  }
  const seg = Buffer.alloc(4 + payload.length)
  seg[0] = 0xff
  seg[1] = 0xe1
  seg.writeUInt16BE(payload.length + 2, 2)
  payload.copy(seg, 4)
  const out = Buffer.alloc(jpeg.length + seg.length)
  jpeg.copy(out, 0, 0, at)
  seg.copy(out, at)
  jpeg.copy(out, at + seg.length, at)
  return out
}

// ---------- ffmpeg 重封装（视频/音频容器） ----------

/** 容器 ext → ffmpeg 输出格式名（重封装用；未知 ext → null = 不支持）
 *  wav 不支持：RIFF INFO muxer 丢弃未知元数据键 → 打标不落盘，按不支持处理；遗留：如需支持可用 `-write_id3v2` TXXX 通道再议 */
const REMUX_FORMAT: Record<string, string> = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', mp3: 'mp3', m4a: 'ipod' }

/** REMUX_FORMAT 查找（原型链防护：'constructor' 等非自有键不得命中；未知 ext → null = 不支持） */
function remuxFormatFor(ext: string): string | null {
  if (!Object.hasOwn(REMUX_FORMAT, ext)) return null
  const fmt = REMUX_FORMAT[ext]
  return typeof fmt === 'string' && fmt ? fmt : null
}

/** 共享内核：-c copy 流复制重封装写元数据到 outAbs（含 -movflags +use_metadata_tags——mp4/mov 系 muxer
 *  默认丢弃未知元数据键，须显式开启自由键写入；mp3 muxer 忽略该选项，走 ID3v2 TXXX 原生路径）。
 *  outAbs 的生命周期由调用方负责；成功 true / 失败 false。
 *  异步 spawn（对齐 ffmpeg-merge/exec.ts runFfmpeg 仓内惯例，热路径不阻塞事件循环；
 *  timeout 60s 由 spawn 选项 kill 等价 spawnSync timeout 语义——kill 后 close 非 0 → false） */
async function remuxToFile(srcAbs: string, ext: string, metaJson: string, outAbs: string): Promise<boolean> {
  const fmt = remuxFormatFor(ext)
  const ffmpeg = resolveFfmpeg()
  if (!fmt || !ffmpeg) return false
  try {
    return await new Promise<boolean>((resolve) => {
      const child = spawn(
        ffmpeg,
        ['-y', '-i', srcAbs, '-map', '0', '-c', 'copy', '-movflags', '+use_metadata_tags', '-metadata', `${AIGC_META_KEY}=${metaJson}`, '-f', fmt, outAbs],
        { stdio: 'ignore', timeout: 60_000, windowsHide: true },
      )
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0 && existsSync(outAbs)))
    })
  } catch {
    return false
  }
}

/** ffmpeg -c copy 重封装写元数据（流复制不重编码；tmp+rename 原子替换）；成功 true / 失败 false */
export async function remuxMediaMeta(absPath: string, ext: string, metaJson: string): Promise<boolean> {
  const tmp = `${absPath}.aigc-tmp`
  let ok = false
  try {
    ok = await remuxToFile(absPath, ext, metaJson, tmp)
    if (ok) renameSync(tmp, absPath)
    return ok
  } catch {
    return false
  } finally {
    // 所有失败路径清除 .aigc-tmp 残留（成功路径 tmp 已被 rename 走 → ENOENT 静默）
    try { unlinkSync(tmp) } catch { /* 清理失败不影响判定 */ }
  }
}

/** 重封装写元数据到指定输出（非破坏性：不改原文件；发布包打标用）；成功 true / 失败 false */
export async function remuxMediaMetaToFile(absPath: string, ext: string, metaJson: string, outAbs: string): Promise<boolean> {
  return remuxToFile(absPath, ext, metaJson, outAbs)
}

export interface ImplicitLabelResult { ok: boolean; produceId: string | null; error?: string }

const IMAGE_PURE_EXT = new Set(['png', 'jpg', 'jpeg'])

/** 单文件隐式标识（统一入口）：图像纯 Node 段插入、音视频 ffmpeg 重封装；失败旁路不抛 */
export async function applyImplicitLabel(absPath: string, ext: string, opts: { producer: string }): Promise<ImplicitLabelResult> {
  try {
    const { json, produceId } = aigcMetadata({ producer: opts.producer })
    if (IMAGE_PURE_EXT.has(ext)) {
      const buf = readFileSync(absPath)
      const out = ext === 'png' ? insertPngText(buf, json) : insertJpegApp1(buf, json)
      if (!out) return { ok: false, produceId: null, error: `insert failed: ext=${ext}` }
      const tmp = `${absPath}.aigc-tmp`
      try {
        writeFileSync(tmp, out)
        renameSync(tmp, absPath)
      } finally {
        // 所有失败路径清除 .aigc-tmp 残留（成功路径 tmp 已被 rename 走 → ENOENT 静默；与重封装路径同律）
        try { unlinkSync(tmp) } catch { /* 清理失败不影响判定 */ }
      }
      return { ok: true, produceId }
    }
    if (remuxFormatFor(ext)) {
      return (await remuxMediaMeta(absPath, ext, json)) ? { ok: true, produceId } : { ok: false, produceId: null, error: `remux failed: ext=${ext}` }
    }
    return { ok: false, produceId: null, error: `unsupported ext=${ext}` }
  } catch (err) {
    return { ok: false, produceId: null, error: (err as Error).message }
  }
}

/** 生成落盘点统一薄入口：读平台 brand compliance.producer → 打标；异常仅 warn 不抛（调用方照常登记资产） */
export async function labelGeneratedFile(abs: string, ext: string): Promise<ImplicitLabelResult> {
  try {
    const { readPlatformBrand } = await import('./brand-config')
    const brand = await readPlatformBrand()
    const producer = (brand as { compliance?: { producer?: string } }).compliance?.producer ?? '个人创作者'
    const r = await applyImplicitLabel(abs, ext, { producer })
    if (!r.ok) log.warn(`隐式标识写入失败（不阻断，产物照常入库）: ${abs} → ${r.error}`)
    return r
  } catch (err) {
    log.warn(`隐式标识入口异常（不阻断）: ${abs} → ${(err as Error).message}`)
    return { ok: false, produceId: null, error: (err as Error).message }
  }
}
