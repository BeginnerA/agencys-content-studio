/// <reference types="node" />
/**
 * 画布学习实例 seed · 占位素材生成（PNG / WAV / SRT；零依赖）。
 *
 * 从 seed-learning-canvases.ts 拆分而来（行为零变更切分，纯函数区，无 HTTP / 领域依赖）：
 * 由全新构造的真实可解码 PNG / 静音 WAV / 示例 SRT 字节，供 seed 主流程上传进项目资产库。
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

export type RGB = [number, number, number]

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
}

export interface SceneSpec {
  w: number
  h: number
  top: RGB
  bottom: RGB
  light: RGB
}

/** 渐变 + 左上柔光 + 底部字幕条 + 轻网格线的占位场景图（真实可解码 PNG） */
export function makeScenePng(s: SceneSpec): Buffer {
  const raw = Buffer.alloc(s.h * (1 + s.w * 3))
  let o = 0
  for (let y = 0; y < s.h; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < s.w; x++) {
      let [r, g, b] = mixRGB(s.top, s.bottom, y / (s.h - 1))
      const dx = x / s.w - 0.22
      const dy = y / s.h - 0.18
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.1) * 0.5
      r = mix(r, s.light[0], glow)
      g = mix(g, s.light[1], glow)
      b = mix(b, s.light[2], glow)
      if (y > s.h * 0.86) {
        r = Math.round(r * 0.55)
        g = Math.round(g * 0.55)
        b = Math.round(b * 0.55)
      }
      if (x % 160 < 2 || y % 160 < 2) {
        r = Math.min(255, r + 14)
        g = Math.min(255, g + 14)
        b = Math.min(255, b + 14)
      }
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(s.w, 0)
  ihdr.writeUInt32BE(s.h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 蒙版占位图：黑底 + 中央白色矩形（inpaint 的重绘区域；真实可解码 PNG） */
export function makeMaskPng(w: number, h: number): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3))
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const cx = x / w - 0.5
      const cy = y / h - 0.5
      const v = Math.abs(cx) < 0.3 && Math.abs(cy) < 0.34 ? 255 : 0
      raw[o++] = v
      raw[o++] = v
      raw[o++] = v
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 静音 WAV（占位 BGM；格式合法可解码） */
export function makeSilentWav(seconds = 2, sampleRate = 16000): Buffer {
  const dataSize = seconds * sampleRate * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

/** 示例 SRT（2 条 cue，与综合画布 2 段合成对齐） */
export const SRT_TEXT = `1
00:00:00,000 --> 00:00:05,000
小杨走进咖啡馆，对着镜头微笑：今天也要元气满满呀。

2
00:00:05,000 --> 00:00:10,000
朋友举起咖啡杯：干杯，为我们的小店！
`
