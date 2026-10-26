/**
 * AIGC 合规标识服务（M66）：
 * - 隐式标识国标六字段（GB 45438-2025 /《标识办法》第五条）：Label/ContentProducer/ProduceID/ReservedCode1/ContentPropagator/PropagateID
 * - 载体：PNG tEXt（纯 Node chunk 插入）、JPEG APP1（纯 Node 段插入）、视频/音频容器（ffmpeg -c copy 重封装）
 * - 红线：隐式标识不可关；失败旁路不阻断（返回 ok:false，调用方 warn + tags 标记）；
 *   纯函数探针直测；绝不重新编码图像像素数据（PNG/JPEG 只做字节级段插入）
 */
import { randomUUID } from 'node:crypto'
import { crc32 } from 'node:zlib'

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

/** 产国标六字段 JSON（纯函数；producer 空值兜底「个人创作者」） */
export function aigcMetadata(opts: { producer: string; contentPropagator?: string; propagateId?: string }): {
  json: string
  produceId: string
  meta: AigcMeta
} {
  const meta: AigcMeta = {
    Label: '1',
    ContentProducer: opts.producer?.trim() || '个人创作者',
    ProduceID: randomUUID(),
    ReservedCode1: '',
    ContentPropagator: opts.contentPropagator?.trim() ?? '',
    PropagateID: opts.propagateId?.trim() ?? '',
  }
  return { json: JSON.stringify(meta), produceId: meta.ProduceID, meta }
}

/** PNG tEXt 块插入（IHDR 之后；keyword AIGC\0 + JSON 值；CRC32 用 zlib.crc32（Node≥22.2）；非 PNG → null） */
export function insertPngText(png: Buffer, metaJson: string): Buffer | null {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return null
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
    at += 2 + jpeg.readUInt16BE(at + 2)
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
