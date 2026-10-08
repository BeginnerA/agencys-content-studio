/**
 * 画布学习实例 seed —— 创建演示项目「画布学习实例」及 9 个复杂画布（含短剧实战、三级合成与季级四级合成）。
 *
 * 目的：给用户一套可直接在 UI 中打开、把玩、运行的画布教学实例，
 * 覆盖全部节点类型（asset/gen/text/entity/run 中除 run 外全部）、
 * 全部端口（reference/first_frame/last_frame/source/prompt/text/video/audio）、
 * gen 子类型（image/video/audio/compose/llm）、edit（inpaint/outpaint）、
 * 多级合成（compose → compose 链，08 到三级、09 到季级四级）、分组（含嵌套三层）、seq 故事板序号、快照、视口。
 *
 * 方式：纯 HTTP API 驱动（服务需已启动，默认 http://127.0.0.1:3001），
 * 占位素材（5 图 + 静音 WAV + 示例 SRT，含全新蒙版图）由脚本内置生成（零依赖），上传进项目资产库。
 * 幂等：同名项目 / 实体 / 素材（sha256 去重）/ 画布复用；画布已有节点则跳过填充。
 *
 * 运行：pnpm --filter @acs/server exec tsx scripts/seed-learning-canvases.ts
 * 可用环境变量 CSTUDIO_BASE_URL 覆盖服务地址。
 */
/// <reference types="node" />
import { deflateSync } from 'node:zlib'

const BASE = process.env.CSTUDIO_BASE_URL ?? 'http://127.0.0.1:3001'
const API = `${BASE}/api/v1`
const PROJECT_NAME = '画布学习实例'

function log(msg: string): void {
  console.log(`[seed] ${msg}`)
}

// ---------- HTTP 工具 ----------

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* 保留原始文本用于报错 */
  }
  if (!res.ok) {
    const detail = data?.error?.message ?? text.slice(0, 300)
    throw new Error(`${method} ${path} → ${res.status}：${detail}`)
  }
  return data
}

async function uploadMedia(projectId: number, filename: string, bytes: Buffer | Uint8Array, mime: string, purpose: string): Promise<number> {
  const fd = new FormData()
  fd.set('purpose', purpose)
  fd.set('file', new Blob([bytes as BlobPart], { type: mime }), filename)
  const res = await fetch(`${API}/projects/${projectId}/imports`, { method: 'POST', body: fd })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* ignore */
  }
  if (!res.ok || !data?.items?.[0]) {
    throw new Error(`上传素材 ${filename} 失败：${res.status} ${data?.error?.message ?? text.slice(0, 200)}`)
  }
  return data.items[0].id as number
}

async function uploadEntityRef(entityId: number, filename: string, bytes: Buffer, mime: string): Promise<void> {
  const fd = new FormData()
  fd.set('file', new Blob([bytes as BlobPart], { type: mime }), filename)
  const res = await fetch(`${API}/entities/${entityId}/ref-images`, { method: 'POST', body: fd })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`上传实体参考图 ${filename} 失败：${res.status} ${text.slice(0, 200)}`)
  }
}

// ---------- 占位素材生成（PNG / WAV / SRT；零依赖） ----------

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

type RGB = [number, number, number]

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
}

interface SceneSpec {
  w: number
  h: number
  top: RGB
  bottom: RGB
  light: RGB
}

/** 渐变 + 左上柔光 + 底部字幕条 + 轻网格线的占位场景图（真实可解码 PNG） */
function makeScenePng(s: SceneSpec): Buffer {
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
function makeMaskPng(w: number, h: number): Buffer {
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
function makeSilentWav(seconds = 2, sampleRate = 16000): Buffer {
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
const SRT_TEXT = `1
00:00:00,000 --> 00:00:05,000
小杨走进咖啡馆，对着镜头微笑：今天也要元气满满呀。

2
00:00:05,000 --> 00:00:10,000
朋友举起咖啡杯：干杯，为我们的小店！
`

// ---------- 领域操作 ----------

async function ensureProject(): Promise<number> {
  const list = await api('GET', '/projects?status=active')
  const found = (list.items as any[]).find((p) => p.name === PROJECT_NAME)
  if (found) {
    log(`复用项目 #${found.id}（${PROJECT_NAME}）`)
    return found.id as number
  }
  const r = await api('POST', '/projects', {
    name: PROJECT_NAME,
    genre: 'other',
    template_key: 'mengbao-episode',
    brief: '内置 9 个复杂画布示例（含短剧实战、三级与季级四级合成链），用于学习创作画布的全部核心能力：节点类型 / 端口连线 / 编辑 / 多级合成 / 锁版 / 分组嵌套 / 快照。可直接把玩、运行与改造。',
    tags: ['学习', '画布示例'],
  })
  log(`已创建项目 #${r.project.id}（${PROJECT_NAME}）`)
  return r.project.id as number
}

async function ensureEntity(projectId: number, kind: string, name: string, extra: Record<string, unknown>): Promise<number> {
  const list = await api('GET', `/entities?project_id=${projectId}&kind=${kind}`)
  const found = (list.items as any[]).find((e) => e.name === name)
  if (found) return found.id as number
  const r = await api('POST', '/entities', { kind, name, project_id: projectId, ...extra })
  log(`  已创建实体【${kind}】${name} #${r.entity.id}`)
  return r.entity.id as number
}

async function ensureCanvas(projectId: number, name: string): Promise<{ id: number; needFill: boolean }> {
  const list = await api('GET', `/projects/${projectId}/canvases`)
  const found = (list.items as any[]).find((c) => c.name === name)
  if (found) {
    const doc = await api('GET', `/canvases/${found.id}`)
    return { id: found.id as number, needFill: (doc.nodes as any[]).length === 0 }
  }
  const r = await api('POST', `/projects/${projectId}/canvases`, { name })
  return { id: r.canvas.id as number, needFill: true }
}

interface NodeIds {
  [key: string]: number
}

async function addText(cid: number, x: number, y: number, title: string, text: string): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'text', spec: { text }, x, y, title })
  return r.node.id as number
}

async function addGen(cid: number, x: number, y: number, title: string, spec: Record<string, unknown>): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'gen', spec, x, y, title })
  return r.node.id as number
}

async function addAssetNode(cid: number, x: number, y: number, title: string, assetId: number): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'asset', assetId, x, y, title })
  return r.node.id as number
}

async function addEntityNode(cid: number, x: number, y: number, title: string, entityId: number): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/nodes`, { kind: 'entity', entityId, x, y, title })
  return r.node.id as number
}

async function link(cid: number, from: number, to: number, port: string): Promise<void> {
  await api('POST', `/canvases/${cid}/edges`, { from, to, port })
}

async function setSeq(nodeId: number, seq: number): Promise<void> {
  await api('PATCH', `/nodes/${nodeId}`, { seq })
}

async function group(cid: number, title: string, color: string, nodeIds?: number[], groupIds?: number[]): Promise<number> {
  const r = await api('POST', `/canvases/${cid}/groups`, { title, color, nodeIds, groupIds })
  return r.group.id as number
}

async function setViewport(cid: number, zoom: number): Promise<void> {
  await api('PATCH', `/canvases/${cid}`, { viewport: { x: 0, y: 0, zoom } })
}

async function snapshot(cid: number, label: string): Promise<void> {
  await api('POST', `/canvases/${cid}/snapshots`, { label })
}

// ---------- 九个教学画布（01-06 基础串联 + 07 两级短剧 + 08 三级全集 + 09 季级四级） ----------

interface Assets {
  cafeImg: number
  duskImg: number
  cameraImg: number
  bgmWav: number
  srt: number
  /** 蒙版占位图（08 编辑链 inpaint 用） */
  maskImg: number
}

interface Entities {
  xiaoyang: number
  cafeScene: number
  ale: number
  duskStreet: number
  /** 09 季级实战新增：学徒小宇 */
  xiaoyu: number
}

/** 01 · 入门：文本 → 图片生成 */
async function buildCanvas1(cid: number): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：认识最基本的「提示词 → 图片」链路。',
    '',
    '① 左侧两个文本节点是画面描述，经 prompt 端口（橙色连线）喂给右侧图片生成节点；',
    '② 选中生成节点 → 右侧检查器可改尺寸等参数，点「运行」出图（可选 ×1~×4 变体）；',
    '③ 两个生成节点带 seq 序号（故事板角标），用于排序与导出命名，不参与执行；',
    '④ 试试：拖动节点、框选多个节点一起移动、Ctrl+滚轮缩放、滚轮平移。',
  ].join('\n'))
  n.t1 = await addText(cid, 40, 360, '提示词 · 镜头1', '清晨的咖啡馆，木质桌面上冒着热气的拿铁，阳光透过落地窗形成柔和逆光，浅景深，电影感光影，写实摄影风格')
  n.t2 = await addText(cid, 40, 680, '提示词 · 镜头2', '清晨咖啡馆全景，暖色木质装修，窗外街道微亮，晨雾与光束穿过玻璃，安静氛围，广角镜头，写实摄影风格')
  n.g1 = await addGen(cid, 460, 340, '镜头1 · 拿铁特写', { genKind: 'image', prompt: '', size: '1024x1024' })
  n.g2 = await addGen(cid, 460, 660, '镜头2 · 咖啡馆全景', { genKind: 'image', prompt: '', size: '1024x1024' })
  await link(cid, n.t1, n.g1, 'prompt')
  await link(cid, n.t2, n.g2, 'prompt')
  await setSeq(n.g1, 1)
  await setSeq(n.g2, 2)
  await group(cid, '① 提示词', 'gray', [n.t1, n.t2])
  await group(cid, '② 图片生成', 'amber', [n.g1, n.g2])
  await setViewport(cid, 0.9)
}

/** 02 · 参考图：多参考 / 局部重绘 / 扩图 */
async function buildCanvas2(cid: number, assets: Assets): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：参考图进、生成图出，以及编辑节点（局部重绘 / 扩图）。',
    '',
    '① 图片素材经 reference 端口（紫色）给生成节点当参考（图片节点≤6 张、视频≤2 张）；',
    '② 生成节点的产物也能继续被下游节点当参考——形成链式迭代；',
    '③ 局部重绘节点需先在检查器里涂抹蒙版并保存，右下节点的问题清单会提示缺什么；',
    '④ 扩图（outpaint）在 spec.edit.expand 里设扩展比例；',
    '⑤ 试试：删掉一条连线再重新拖接、把参考图节点拖到别的生成节点旁。',
  ].join('\n'))
  n.a1 = await addAssetNode(cid, 40, 400, '参考图 · 清晨咖啡馆', assets.cafeImg)
  n.a2 = await addAssetNode(cid, 40, 740, '参考图 · 复古相机', assets.cameraImg)
  n.g1 = await addGen(cid, 460, 380, '多参考 · 场景变体', { genKind: 'image', prompt: '融合两张参考图的元素，生成同一场景的三种构图变体', size: '1024x1024' })
  n.g2 = await addGen(cid, 460, 720, '链式参考 · 二次细化', { genKind: 'image', prompt: '在参考图基础上细化细节、统一色调与光照', size: '1024x1024' })
  n.e1 = await addGen(cid, 880, 380, '局部重绘 · inpaint（待涂蒙版）', { genKind: 'image', prompt: '把画面里的拿铁杯替换成玻璃水杯', size: '1024x1024', edit: { mode: 'inpaint' } })
  n.e2 = await addGen(cid, 880, 720, '扩图 · outpaint', { genKind: 'image', prompt: '向画面四周扩展，补全窗外街道与天空', size: '1024x1024', edit: { mode: 'outpaint', expand: { xScale: 1.5, yScale: 1.5 } } })
  await link(cid, n.a1, n.g1, 'reference')
  await link(cid, n.a2, n.g1, 'reference')
  await link(cid, n.g1, n.g2, 'reference')
  await link(cid, n.a1, n.e1, 'source')
  await link(cid, n.g1, n.e2, 'source')
  await setSeq(n.g1, 1)
  await setSeq(n.g2, 2)
  await group(cid, '参考素材', 'gray', [n.a1, n.a2])
  await group(cid, '生成链（链式参考）', 'purple', [n.g1, n.g2])
  await group(cid, '编辑区（重绘 / 扩图）', 'red', [n.e1, n.e2])
  await setViewport(cid, 0.85)
}

/** 03 · 视频：首尾帧与运镜 */
async function buildCanvas3(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：视频生成节点的三种输入方式。',
    '',
    '① first_frame / last_frame（首帧 / 尾帧）：各接 1 张图片，控制镜头起点与终点；',
    '② reference（参考图 ≤2）：不锁首尾帧，只给风格 / 角色参考；',
    '③ prompt 端口：接文本节点的运镜与动作描述；',
    '④ 实体节点（角色 · 小杨）可直接当参考——角色跨镜头一致性的关键；',
    '⑤ 视频节点 spec 可设 duration（秒）、resolution、aspectRatio。',
  ].join('\n'))
  n.t1 = await addText(cid, 40, 400, '运镜描述', '镜头从咖啡杯特写缓慢推向窗外街景，晨光逐渐变暖，轻微手持晃动感')
  n.a1 = await addAssetNode(cid, 40, 740, '首帧 · 清晨咖啡馆', assets.cafeImg)
  n.a2 = await addAssetNode(cid, 40, 1060, '尾帧 · 黄昏街景', assets.duskImg)
  n.ent1 = await addEntityNode(cid, 40, 1380, '角色 · 小杨（实体）', entities.xiaoyang)
  n.v1 = await addGen(cid, 460, 400, '视频1 · 首尾帧过渡', { genKind: 'video', prompt: '', duration: 5, resolution: '720p', aspectRatio: '16:9' })
  n.v2 = await addGen(cid, 460, 820, '视频2 · 角色参考 + 运镜', { genKind: 'video', prompt: '小杨推门走进咖啡馆，镜头平移跟随，自然光', duration: 5, resolution: '720p', aspectRatio: '16:9' })
  await link(cid, n.t1, n.v1, 'prompt')
  await link(cid, n.a1, n.v1, 'first_frame')
  await link(cid, n.a2, n.v1, 'last_frame')
  await link(cid, n.a1, n.v2, 'reference')
  await link(cid, n.ent1, n.v2, 'reference')
  await setSeq(n.v1, 1)
  await setSeq(n.v2, 2)
  await group(cid, '视频生成', 'orange', [n.v1, n.v2])
  await group(cid, '文本与素材', 'gray', [n.t1, n.a1, n.a2, n.ent1])
  await setViewport(cid, 0.7)
}

/** 04 · 配音 + 合成：成片流水线 */
async function buildCanvas4(cid: number, assets: Assets): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：audio（配音）与 compose（合成）节点。',
    '',
    '① 文本节点经 prompt 连到 audio 节点即生成配音，可设 voice / speed / emotion；',
    '② compose 多入单出：video 口接画面（≤4）、audio 口接配音（≤4），连线顺序即配对顺序；',
    '③ align=true → video[i] ↔ audio[i] 按顺序对齐（段时长取较长者）；字幕 auto 用配音文本自动生成；',
    '④ BGM 不走连线：在 compose 检查器中选择本项目音频资产（左下是已上传的占位 BGM）；',
    '⑤ 先运行上游（出画/出声）再运行合成节点；合成（ffmpeg）零外部计费。',
  ].join('\n'))
  n.t1 = await addText(cid, 40, 420, '旁白 · 第1句', '清晨的第一缕阳光落在咖啡杯上，新的一天开始了。')
  n.t2 = await addText(cid, 40, 740, '旁白 · 第2句', '她推开门，熟悉的风铃声响起——老地方，老味道。')
  n.bgm = await addAssetNode(cid, 40, 1060, 'BGM · 占位音频（静音 wav）', assets.bgmWav)
  n.v1 = await addGen(cid, 460, 400, '画面1 · 拿铁特写', { genKind: 'video', prompt: '拿铁咖啡特写，热气升腾，镜头缓慢推近', duration: 4, resolution: '720p', aspectRatio: '16:9' })
  n.v2 = await addGen(cid, 460, 720, '画面2 · 推门入店', { genKind: 'video', prompt: '小杨推门走进咖啡馆，风铃晃动，镜头平移跟随', duration: 4, resolution: '720p', aspectRatio: '16:9' })
  n.au1 = await addGen(cid, 460, 1040, '配音 · 第1句', { genKind: 'audio', prompt: '', speed: 1 })
  n.au2 = await addGen(cid, 460, 1360, '配音 · 第2句', { genKind: 'audio', prompt: '', speed: 1 })
  n.c1 = await addGen(cid, 880, 700, '合成 · 成片（对齐 + 自动字幕）', {
    genKind: 'compose', prompt: '',
    transition: 'dissolve', transitionDuration: 0.5,
    align: true, subtitle: 'auto', burnSubtitles: false, fit: 'pad', fps: 30,
    bgmAssetId: assets.bgmWav, bgmVolume: 0.35, bgmFade: true,
  })
  await link(cid, n.t1, n.au1, 'prompt')
  await link(cid, n.t2, n.au2, 'prompt')
  await link(cid, n.v1, n.c1, 'video')
  await link(cid, n.v2, n.c1, 'video')
  await link(cid, n.au1, n.c1, 'audio')
  await link(cid, n.au2, n.c1, 'audio')
  await setSeq(n.v1, 1)
  await setSeq(n.v2, 2)
  await setSeq(n.c1, 3)
  await group(cid, '文案', 'gray', [n.t1, n.t2])
  await group(cid, '画面', 'blue', [n.v1, n.v2])
  await group(cid, '配音', 'green', [n.au1, n.au2])
  await group(cid, '合成', 'red', [n.c1])
  await group(cid, 'BGM（spec.bgmAssetId 指向它）', 'pink', [n.bgm])
  await setViewport(cid, 0.65)
}

/** 05 · LLM 文本处理链 */
async function buildCanvas5(cid: number): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：llm 节点的「材料 + 指令 → 产物 → 再加工」。',
    '',
    '① text 端口（青色）：多段文本材料（≤4）作为 LLM 的上下文输入；',
    '② prompt 端口（橙色）：指令。可来自文本节点，也可来自上游 LLM 的产物；',
    '③ LLM 产物是 text 资产：可继续喂下游 LLM（改写链），也能直接给图片节点当提示词；',
    '④ 运行 LLM 前需在「设置 → AI 配置」配好 LLM 实例，否则问题清单会提示未配置；',
    '⑤ 检查器可调 temperature / maxTokens。',
  ].join('\n'))
  n.t1 = await addText(cid, 40, 420, '素材 · 产品卖点', '手冲咖啡豆：云南高海拔产区、日晒处理、果香明亮、回甘持久、限量 200 包。')
  n.t2 = await addText(cid, 40, 740, '素材 · 用户评价', '用户A：果香明显，酸度轻盈，早上来一杯很提神。用户B：包装好看，送人很有面子，回购第三次了。')
  n.t3 = await addText(cid, 40, 1060, '指令 · 标题生成', '根据材料提炼 5 个短视频标题：每条不超过 15 字，带情绪钩子，避免夸张词。')
  n.l1 = await addGen(cid, 460, 660, 'LLM1 · 标题生成', { genKind: 'llm', prompt: '', temperature: 0.9, maxTokens: 2000 })
  n.l2 = await addGen(cid, 880, 460, 'LLM2 · 风格改写', { genKind: 'llm', prompt: '把上游生成的标题改写成小红书种草文案：口语化、带 2-3 个 emoji 和话题标签' })
  n.g1 = await addGen(cid, 880, 880, '图片 · 用 LLM 文案出图', { genKind: 'image', prompt: '', size: '1024x1024' })
  await link(cid, n.t1, n.l1, 'text')
  await link(cid, n.t2, n.l1, 'text')
  await link(cid, n.t3, n.l1, 'prompt')
  await link(cid, n.l1, n.l2, 'prompt')
  await link(cid, n.l2, n.g1, 'prompt')
  await group(cid, '输入材料', 'gray', [n.t1, n.t2, n.t3])
  await group(cid, 'LLM 链', 'purple', [n.l1, n.l2])
  await group(cid, '产物复用', 'amber', [n.g1])
  await setViewport(cid, 0.8)
}

/** 06 · 综合实战：嵌套分组 + 全要素 */
async function buildCanvas6(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：把前面所有能力串成一条完整流水线，并体验分组嵌套与快照。',
    '',
    '① 嵌套分组：外层「第一幕」包住「画面」「配音」「素材」三个子组；组可折叠、改名、换色；',
    '② 实体节点（角色小杨 / 场景咖啡馆）作为参考图来源，保证跨镜头一致性；',
    '③ 画面链：图片 →（首帧/尾帧）→ 视频；音频链：台词 → 配音；',
    '④ compose 用 subtitle=asset 重钉已有 SRT 字幕（见「素材」组末尾的字幕节点）并烧录（burnSubtitles）；',
    '⑤ 右上角「快照」：已存了一份初始快照，随便折腾后可以一键恢复。',
  ].join('\n'))
  n.ent1 = await addEntityNode(cid, 40, 1060, '角色 · 小杨', entities.xiaoyang)
  n.ent2 = await addEntityNode(cid, 40, 1380, '场景 · 咖啡馆', entities.cafeScene)
  n.a1 = await addAssetNode(cid, 40, 1700, '参考 · 黄昏街景', assets.duskImg)
  n.t1 = await addText(cid, 40, 420, '台词 · 小杨', '小杨走进咖啡馆，对着镜头微笑：今天也要元气满满呀。')
  n.t2 = await addText(cid, 40, 740, '台词 · 朋友', '朋友举起咖啡杯：干杯，为我们的小店！')
  n.srt = await addAssetNode(cid, 40, 2020, '字幕 · 示例 SRT（subtitle=asset 用）', assets.srt)
  n.img1 = await addGen(cid, 460, 400, '分镜1 · 窗边喝咖啡', { genKind: 'image', prompt: '小杨坐在窗边搅拌拿铁，暖色晨光，写实电影感', size: '1024x1024' })
  n.img2 = await addGen(cid, 460, 720, '分镜2 · 拿铁特写', { genKind: 'image', prompt: '特写：木质桌上的拿铁，窗外黄昏，浅景深', size: '1024x1024' })
  n.img3 = await addGen(cid, 460, 1040, '分镜3 · 碰杯瞬间', { genKind: 'image', prompt: '小杨与朋友碰杯的瞬间，笑容灿烂，暖调', size: '1024x1024' })
  n.v1 = await addGen(cid, 880, 400, '视频1 · 环绕镜头', { genKind: 'video', prompt: '镜头缓慢环绕，从拿铁推向窗边的小杨', duration: 5, resolution: '720p', aspectRatio: '16:9' })
  n.v2 = await addGen(cid, 880, 720, '视频2 · 碰杯慢镜头', { genKind: 'video', prompt: '碰杯动作慢镜头，光线温暖', duration: 5, resolution: '720p', aspectRatio: '16:9' })
  n.au1 = await addGen(cid, 880, 1040, '配音 · 小杨', { genKind: 'audio', prompt: '', speed: 1 })
  n.au2 = await addGen(cid, 880, 1360, '配音 · 朋友', { genKind: 'audio', prompt: '', speed: 1 })
  n.c1 = await addGen(cid, 1300, 700, '成片 · 对齐 + SRT 字幕烧录', {
    genKind: 'compose', prompt: '',
    transition: 'fade', transitionDuration: 0.6,
    align: true, subtitle: 'asset', subtitleAssetId: assets.srt, burnSubtitles: true, fit: 'crop', fps: 30,
  })
  await link(cid, n.ent1, n.img1, 'reference')
  await link(cid, n.ent2, n.img1, 'reference')
  await link(cid, n.a1, n.img2, 'reference')
  await link(cid, n.ent1, n.img3, 'reference')
  await link(cid, n.img1, n.v1, 'first_frame')
  await link(cid, n.img2, n.v1, 'last_frame')
  await link(cid, n.img3, n.v2, 'first_frame')
  await link(cid, n.t1, n.au1, 'prompt')
  await link(cid, n.t2, n.au2, 'prompt')
  await link(cid, n.v1, n.c1, 'video')
  await link(cid, n.v2, n.c1, 'video')
  await link(cid, n.au1, n.c1, 'audio')
  await link(cid, n.au2, n.c1, 'audio')
  await setSeq(n.img1, 1)
  await setSeq(n.img2, 2)
  await setSeq(n.img3, 3)
  await setSeq(n.v1, 4)
  await setSeq(n.v2, 5)
  await setSeq(n.c1, 6)
  const gShots = await group(cid, '画面', 'blue', [n.img1, n.img2, n.img3, n.v1, n.v2])
  const gVoices = await group(cid, '配音', 'green', [n.au1, n.au2])
  const gSource = await group(cid, '素材', 'gray', [n.ent1, n.ent2, n.a1, n.t1, n.t2, n.srt])
  await group(cid, '第一幕（嵌套父组）', 'amber', undefined, [gShots, gVoices, gSource])
  await group(cid, '成片', 'red', [n.c1])
  await snapshot(cid, '教学快照 · 初始版')
  await setViewport(cid, 0.55)
}

/** 07 · 短剧实战：《元气小杨的一天》第1集（多场次 · 两级合成） */
async function buildCanvas7(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：用画布完整排一集竖屏短剧，体验「两级合成」与全链路分组嵌套。',
    '',
    '① 结构：素材/实体 → 分镜图 → 镜头视频 → 场次合成A/B → 总合成；',
    '② 两级合成：场次合成（compose）的产物可再作为总合成节点的 video 输入（compose → compose 连线）；',
    '③ 场次合成开 align + 字幕 auto + 烧录；总合成只拼场次片、加转场与 BGM（BGM 走 spec.bgmAssetId）；',
    '④ 实体（小杨 / 阿乐 / 咖啡馆 / 黄昏街道）保证角色与场景跨镜头一致，seq 为全片生产顺序；',
    '⑤ 运行节奏：点「运行」先跑就绪节点（分镜图 / 配音）→ 再次运行出镜头视频 → 再运行出场次片 → 最后运行出总合成；',
    '⑥ 交付层：竖版封面图（1024x1536）与 LLM 发布文案；运行需要先配置对应 AI 供应商。',
  ].join('\n'))
  // —— 素材与实体（跨镜头一致性）——
  n.entX = await addEntityNode(cid, 40, 460, '角色 · 小杨', entities.xiaoyang)
  n.entC = await addEntityNode(cid, 40, 780, '场景 · 咖啡馆', entities.cafeScene)
  n.entA = await addEntityNode(cid, 40, 1100, '角色 · 阿乐', entities.ale)
  n.aDusk = await addAssetNode(cid, 40, 1420, '场景参考 · 黄昏街道', assets.duskImg)
  n.bgm = await addAssetNode(cid, 40, 1740, 'BGM · 占位音频（静音 wav）', assets.bgmWav)
  // —— 场次A · 咖啡店内（清晨）：3 镜头 + 3 配音 ——
  n.t1 = await addText(cid, 440, 420, '旁白 · 开场', '清晨，城市刚醒。小杨的咖啡店亮起了第一盏灯。')
  n.t2 = await addText(cid, 440, 740, '台词 · 小杨', '（拉花成形）完美！今天也要元气满满呀。')
  n.t3 = await addText(cid, 440, 1060, '台词 · 阿乐', '老板，老样子——还有，听说你要上新品？')
  n.img1 = await addGen(cid, 840, 420, '分镜1 · 吧台做咖啡', { genKind: 'image', prompt: '竖屏短剧分镜：小杨在咖啡店吧台后制作手冲咖啡，清晨暖光，前景咖啡机虚化，电影感', size: '1024x1536' })
  n.img2 = await addGen(cid, 840, 740, '分镜2 · 拉花特写', { genKind: 'image', prompt: '竖屏特写：咖啡杯中拉花成形，热气升腾，木质桌面与暖光', size: '1024x1536' })
  n.img3 = await addGen(cid, 840, 1060, '分镜3 · 店内交谈中景', { genKind: 'image', prompt: '竖屏中景：小杨与阿乐在吧台前交谈，小杨微笑看向镜头，晨光侧逆光，生活质感', size: '1024x1536' })
  n.au1 = await addGen(cid, 1240, 420, '配音 · 开场旁白', { genKind: 'audio', prompt: '', speed: 1 })
  n.au2 = await addGen(cid, 1240, 740, '配音 · 小杨', { genKind: 'audio', prompt: '', speed: 1 })
  n.au3 = await addGen(cid, 1240, 1060, '配音 · 阿乐', { genKind: 'audio', prompt: '', speed: 1 })
  n.v1 = await addGen(cid, 1640, 420, '镜头1 · 吧台全景推近', { genKind: 'video', prompt: '镜头从全景缓慢推近吧台，人影与蒸汽摇曳', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v2 = await addGen(cid, 1640, 740, '镜头2 · 拉花微距', { genKind: 'video', prompt: '拉花特写微距，蒸汽升腾，轻微手持晃动', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v3 = await addGen(cid, 1640, 1060, '镜头3 · 交谈与微笑', { genKind: 'video', prompt: '小杨与阿乐交谈，小杨抬头看向镜头微笑，镜头轻移', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.ca = await addGen(cid, 2040, 740, '场次合成A · 店内片（对齐+字幕）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, fit: 'pad', fps: 30 })
  // —— 场次B · 黄昏街道（钩子结尾）：2 镜头 + 2 配音 ——
  n.t4 = await addText(cid, 440, 1920, '旁白 · 转折', '黄昏，打烊时分，新品终于定稿——明天，会有惊喜吗？')
  n.t5 = await addText(cid, 440, 2240, '台词 · 小杨 · 钩子', '（看向镜头）明天新品首发，第一个来的，我请。')
  n.img4 = await addGen(cid, 840, 1920, '分镜4 · 推门而出', { genKind: 'image', prompt: '竖屏分镜：小杨推开咖啡店玻璃门走上黄昏街道，逆光背影，门口风铃晃动', size: '1024x1536' })
  n.img5 = await addGen(cid, 840, 2240, '分镜5 · 回眸定格', { genKind: 'image', prompt: '竖屏特写：小杨站在黄昏街头回眸看向镜头，眼神明亮，背景街灯虚化', size: '1024x1536' })
  n.au4 = await addGen(cid, 1240, 1920, '配音 · 转折旁白', { genKind: 'audio', prompt: '', speed: 1 })
  n.au5 = await addGen(cid, 1240, 2240, '配音 · 钩子台词', { genKind: 'audio', prompt: '', speed: 1 })
  n.v4 = await addGen(cid, 1640, 1920, '镜头4 · 跟拍推门', { genKind: 'video', prompt: '跟拍小杨推门走出，风铃晃动，黄昏逆光', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v5 = await addGen(cid, 1640, 2240, '镜头5 · 回眸收尾', { genKind: 'video', prompt: '回眸定格，镜头缓推，氛围收尾', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.cb = await addGen(cid, 2040, 2080, '场次合成B · 结尾片（对齐+字幕）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, fit: 'pad', fps: 30 })
  // —— 交付层：总合成 / 封面 / 运营文案 ——
  n.cf = await addGen(cid, 2440, 1400, '总合成 · 第1集成片（拼场次+BGM）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.8, bgmAssetId: assets.bgmWav, bgmVolume: 0.4, bgmFade: true, fit: 'crop', fps: 30 })
  n.cover = await addGen(cid, 2440, 420, '封面 · 竖版短剧封面', { genKind: 'image', prompt: '竖版短剧封面：元气少女小杨倚在咖啡店吧台边微笑，暖色店招灯箱，上方留白标题区，高级质感', size: '1024x1536' })
  n.t6 = await addText(cid, 2440, 1760, '材料 · 卖点与受众', '短剧《元气小杨的一天》第1集：咖啡店新品首发，结尾钩子「第一个来的我请」；受众 18-30 城市青年；平台：短视频。')
  n.t7 = await addText(cid, 2440, 2080, '指令 · 发布文案', '为短剧第1集写发布文案：不超过 80 字，含标题、2-3 个话题标签与互动引导。')
  n.l1 = await addGen(cid, 2440, 2440, 'LLM · 发布文案生成', { genKind: 'llm', prompt: '', temperature: 0.8, maxTokens: 1500 })
  // —— 连线（场次A）——
  await link(cid, n.entX, n.img1, 'reference')
  await link(cid, n.entC, n.img1, 'reference')
  await link(cid, n.entC, n.img2, 'reference')
  await link(cid, n.entX, n.img3, 'reference')
  await link(cid, n.entA, n.img3, 'reference')
  await link(cid, n.img1, n.v1, 'first_frame')
  await link(cid, n.img2, n.v2, 'first_frame')
  await link(cid, n.img3, n.v3, 'first_frame')
  await link(cid, n.t1, n.au1, 'prompt')
  await link(cid, n.t2, n.au2, 'prompt')
  await link(cid, n.t3, n.au3, 'prompt')
  await link(cid, n.v1, n.ca, 'video')
  await link(cid, n.v2, n.ca, 'video')
  await link(cid, n.v3, n.ca, 'video')
  await link(cid, n.au1, n.ca, 'audio')
  await link(cid, n.au2, n.ca, 'audio')
  await link(cid, n.au3, n.ca, 'audio')
  // —— 连线（场次B）——
  await link(cid, n.entX, n.img4, 'reference')
  await link(cid, n.aDusk, n.img4, 'reference')
  await link(cid, n.entX, n.img5, 'reference')
  await link(cid, n.img4, n.v4, 'first_frame')
  await link(cid, n.img5, n.v5, 'first_frame')
  await link(cid, n.t4, n.au4, 'prompt')
  await link(cid, n.t5, n.au5, 'prompt')
  await link(cid, n.v4, n.cb, 'video')
  await link(cid, n.v5, n.cb, 'video')
  await link(cid, n.au4, n.cb, 'audio')
  await link(cid, n.au5, n.cb, 'audio')
  // —— 连线（交付层，含 compose → compose 两级合成）——
  await link(cid, n.ca, n.cf, 'video')
  await link(cid, n.cb, n.cf, 'video')
  await link(cid, n.entX, n.cover, 'reference')
  await link(cid, n.entC, n.cover, 'reference')
  await link(cid, n.t6, n.l1, 'text')
  await link(cid, n.t7, n.l1, 'prompt')
  // —— 序号（全片生产顺序）——
  const seqPlan: Array<[number, number]> = [
    [n.img1, 1], [n.img2, 2], [n.img3, 3], [n.img4, 4], [n.img5, 5],
    [n.v1, 6], [n.v2, 7], [n.v3, 8], [n.v4, 9], [n.v5, 10],
    [n.ca, 11], [n.cb, 12], [n.cf, 13],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（嵌套：剧集父组 ⊃ 场次分镜/配音/合成 六个子组）——
  const gA1 = await group(cid, '分镜 · 店内', 'blue', [n.img1, n.img2, n.img3, n.v1, n.v2, n.v3])
  const gA2 = await group(cid, '配音 · 店内', 'green', [n.t1, n.t2, n.t3, n.au1, n.au2, n.au3])
  const gA3 = await group(cid, '场内片合成', 'red', [n.ca])
  const gB1 = await group(cid, '分镜 · 黄昏街道', 'blue', [n.img4, n.img5, n.v4, n.v5])
  const gB2 = await group(cid, '配音 · 结尾钩子', 'green', [n.t4, n.t5, n.au4, n.au5])
  const gB3 = await group(cid, '结尾片合成', 'red', [n.cb])
  await group(cid, '《元气小杨的一天》第1集（嵌套父组）', 'amber', undefined, [gA1, gA2, gA3, gB1, gB2, gB3])
  await group(cid, '素材与实体（跨镜头一致性）', 'gray', [n.entX, n.entC, n.entA, n.aDusk, n.bgm])
  await group(cid, '交付与运营', 'purple', [n.cover, n.cf, n.t6, n.t7, n.l1])
  await snapshot(cid, '教学快照 · 第1集初始版')
  await setViewport(cid, 0.4)
}

/** 08 · 短剧实战·全集：4 场次 → 2 幕 → 全集（三级合成链 + 锁版 pin + 双快照 + 编辑链） */
async function buildCanvas8(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, -1160, 40, '📖 使用说明', [
    '学习目标：四场次短剧全集生产 —— 三级合成链、字幕三模式、BGM 注入、锁版与双快照。',
    '',
    '① 结构：素材/实体 → 分镜图 → 镜头视频 → 场次合成×4 → 幕片×2 → 全集成片（compose 逐级链）；',
    '② 三级合成：c1..c4（场次片）→ m1/m2（幕片）→ f（全集），逐级拼装、逐级转场（dissolve/fadeblack/fade）；',
    '③ 字幕三模式同画布演示：场次层 subtitle=auto 自动生成并烧录；幕层 none（不写字幕）；全集层 subtitle=asset 重钉 SRT 资产；',
    '④ BGM 仅在全集层注入一次（spec.bgmAssetId / bgmVolume / bgmFade），避免逐段重复混音；',
    '⑤ 锁版 pin：镜头8 的 first_frame 输入被锁定为素材「咖啡馆图」（spec.pin={分镜8: 资产}），无视分镜8 当前产物；',
    '⑥ 编辑链（左下实验区）：outpaint 扩图 → inpaint 局部重绘（已挂蒙版素材），产物可替换任一分镜；',
    '⑦ 双快照：v1 结构就绪 / v2 调声后（au8 语速+情绪），可在快照面板对比与恢复；',
    '⑧ 运行节奏：分镜/配音 → 镜头视频 → 场次片 → 幕片 → 全集成片；未跑上游时下游显示「暂无成功产物」属正常。',
  ].join('\n'))
  // —— 素材与实体（跨镜头一致性）——
  n.entX = await addEntityNode(cid, -1160, 520, '角色 · 小杨', entities.xiaoyang)
  n.entA = await addEntityNode(cid, -1160, 840, '角色 · 阿乐', entities.ale)
  n.entC = await addEntityNode(cid, -1160, 1160, '场景 · 咖啡馆', entities.cafeScene)
  n.entD = await addEntityNode(cid, -1160, 1480, '场景 · 黄昏街道', entities.duskStreet)
  n.aCafe = await addAssetNode(cid, -760, 520, '素材 · 咖啡馆图（锁版目标）', assets.cafeImg)
  n.aDusk = await addAssetNode(cid, -760, 840, '素材 · 黄昏街景', assets.duskImg)
  n.aMask = await addAssetNode(cid, -760, 1160, '蒙版 · 局部重绘区域', assets.maskImg)
  n.bgm = await addAssetNode(cid, -760, 1480, 'BGM · 占位音频（全集注入）', assets.bgmWav)
  n.aSrt = await addAssetNode(cid, -760, 1800, '字幕 · 示例 SRT（全集重钉）', assets.srt)
  // —— 场次1 · 清晨咖啡馆（悬念开场）——
  n.t1 = await addText(cid, 80, 400, '旁白 · 开场', '清晨，小杨推开店门——吧台上，配方本不见了。')
  n.t2 = await addText(cid, 80, 720, '台词 · 阿乐', '别急，昨晚最后走的人，说不定看见了什么。')
  n.img1 = await addGen(cid, 480, 400, '分镜1 · 空吧台', { genKind: 'image', prompt: '竖屏分镜：清晨咖啡馆，小杨推门而入，目光落向空荡的吧台，晨光斜射，氛围微妙紧张', size: '1024x1536' })
  n.img2 = await addGen(cid, 480, 720, '分镜2 · 吧台低语', { genKind: 'image', prompt: '竖屏中景：小杨与阿乐在吧台前低声讨论，咖啡热气升腾，浅景深', size: '1024x1536' })
  n.au1 = await addGen(cid, 880, 400, '配音 · 开场旁白', { genKind: 'audio', prompt: '', speed: 0.95 })
  n.au2 = await addGen(cid, 880, 720, '配音 · 阿乐（紧张）', { genKind: 'audio', prompt: '', speed: 1.05, emotion: '紧张——语速略快，尾音压低' })
  n.v1 = await addGen(cid, 1280, 400, '镜头1 · 推门停顿', { genKind: 'video', prompt: '推门进场，小杨停顿半秒，镜头缓推至空吧台', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v2 = await addGen(cid, 1280, 720, '镜头2 · 低语对话', { genKind: 'video', prompt: '两人对话中景，轻微手持晃动，气氛渐紧', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.c1 = await addGen(cid, 1680, 560, '场次合成1 · 清晨片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 场次2 · 店内推理 ——
  n.t3 = await addText(cid, 2280, 400, '台词 · 小杨', '监控？昨晚打烊后我明明锁了门……')
  n.t4 = await addText(cid, 2280, 720, '台词 · 阿乐 · 发现', '等等，柜台边缘有张纸条——「街角见」。')
  n.img3 = await addGen(cid, 2680, 400, '分镜3 · 查看监控', { genKind: 'image', prompt: '竖屏分镜：小杨俯身查看柜台下的旧监控屏，屏幕蓝光映在脸上', size: '1024x1536' })
  n.img4 = await addGen(cid, 2680, 720, '分镜4 · 纸条特写', { genKind: 'image', prompt: '竖屏特写：阿乐捏起柜台边缘的纸条，纸条上是手写小字「街角见」', size: '1024x1536' })
  n.au3 = await addGen(cid, 3080, 400, '配音 · 小杨（疑惑）', { genKind: 'audio', prompt: '', speed: 0.95 })
  n.au4 = await addGen(cid, 3080, 720, '配音 · 阿乐 · 发现', { genKind: 'audio', prompt: '', speed: 0.98 })
  n.v3 = await addGen(cid, 3480, 400, '镜头3 · 屏幕蓝光', { genKind: 'video', prompt: '俯身查看监控，镜头从背后缓推，蓝光闪烁', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v4 = await addGen(cid, 3480, 720, '镜头4 · 纸条微距', { genKind: 'video', prompt: '纸条微距推近，手写小字逐渐清晰', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.c2 = await addGen(cid, 3880, 560, '场次合成2 · 推理片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 场次3 · 街头追踪 ——
  n.t5 = await addText(cid, 80, 1500, '旁白 · 转折', '黄昏，两人循着线索走向街角。')
  n.t6 = await addText(cid, 80, 1820, '台词 · 小杨 · 辨认', '是他？那个总在窗边画画的年轻人！')
  n.img5 = await addGen(cid, 480, 1500, '分镜5 · 走向街角', { genKind: 'image', prompt: '竖屏分镜：小杨与阿乐并肩走在黄昏街道，走向街角，暮色暖橙', size: '1024x1536' })
  n.img6 = await addGen(cid, 480, 1820, '分镜6 · 路灯辨认', { genKind: 'image', prompt: '竖屏中景：街角路灯下，一个年轻背影正翻着本子，小杨在远处辨认', size: '1024x1536' })
  n.au5 = await addGen(cid, 880, 1500, '配音 · 转折旁白', { genKind: 'audio', prompt: '', speed: 1 })
  n.au6 = await addGen(cid, 880, 1820, '配音 · 小杨（焦急）', { genKind: 'audio', prompt: '', speed: 1.1, emotion: '焦急——呼吸感，断句急促' })
  n.v5 = await addGen(cid, 1280, 1500, '镜头5 · 跟拍前行', { genKind: 'video', prompt: '跟拍两人快步前行，暮色光斑流动', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v6 = await addGen(cid, 1280, 1820, '镜头6 · 路灯下定格', { genKind: 'video', prompt: '长焦望向路灯下的背影，轻微变焦试探', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.c3 = await addGen(cid, 1680, 1660, '场次合成3 · 追踪片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 场次4 · 夜归反转 ——
  n.t7 = await addText(cid, 2280, 1500, '旁白 · 反转', '夜里回到店里，配方本静静躺回吧台，夹着一页感谢信。')
  n.t8 = await addText(cid, 2280, 1820, '台词 · 小杨 · 钩子', '（读信，笑）原来他只想给生病的妈妈烤一个生日蛋糕……下周，我们教他。')
  n.img7 = await addGen(cid, 2680, 1500, '分镜7 · 配方本归来', { genKind: 'image', prompt: '竖屏分镜：夜晚咖啡馆，吧台上配方本与一页信纸静静摆放，暖灯聚焦', size: '1024x1536' })
  n.img8 = await addGen(cid, 2680, 1820, '分镜8 · 读信微笑', { genKind: 'image', prompt: '竖屏中景：小杨与阿乐并肩读信，相视而笑，夜灯暖光', size: '1024x1536' })
  n.au7 = await addGen(cid, 3080, 1500, '配音 · 反转旁白', { genKind: 'audio', prompt: '', speed: 0.95 })
  n.au8 = await addGen(cid, 3080, 1820, '配音 · 钩子台词', { genKind: 'audio', prompt: '', speed: 1 })
  n.v7 = await addGen(cid, 3480, 1500, '镜头7 · 推近配方本', { genKind: 'video', prompt: '从店内全景缓推至吧台上的配方本与信纸', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v8 = await addGen(cid, 3480, 1820, '镜头8 · 收尾定格（输入已锁版）', { genKind: 'video', prompt: '两人读信相视而笑，镜头缓拉开，暖光收尾', duration: 3, resolution: '720p', aspectRatio: '9:16', pin: { [String(n.img8)]: assets.cafeImg } })
  n.c4 = await addGen(cid, 3880, 1660, '场次合成4 · 反转片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 后期总装：幕片 → 全集 → 交付 ——
  n.cover = await addGen(cid, 4380, 40, '封面 · 竖版悬疑封面', { genKind: 'image', prompt: '竖版短剧封面：《被偷走的配方》小杨与阿乐并肩站在夜晚咖啡馆门前，手举暖灯，上方留白标题区，悬疑而温暖', size: '1024x1536' })
  n.m1 = await addGen(cid, 4380, 560, '幕片1 · 第一幕（场次1+2）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  n.m2 = await addGen(cid, 4380, 880, '幕片2 · 第二幕（场次3+4）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  n.f = await addGen(cid, 4780, 720, '全集成片 · 三级链终点（asset 字幕+BGM）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.8, bgmAssetId: assets.bgmWav, bgmVolume: 0.35, bgmFade: true, subtitle: 'asset', subtitleAssetId: assets.srt, fit: 'crop', fps: 30 })
  n.t9 = await addText(cid, 4380, 1320, '材料 · 卖点与受众', '短剧《被偷走的配方》（《元气小杨的一天》第2集）：悬疑轻喜，四场次两幕结构；卖点：反转温情结局；受众 18-30 城市青年。')
  n.t10 = await addText(cid, 4380, 1640, '指令 · 发布文案', '为短剧第2集写发布文案：不超过 80 字，含标题、2-3 个话题标签与互动引导。')
  n.l1 = await addGen(cid, 4780, 1480, 'LLM · 发布文案生成', { genKind: 'llm', prompt: '', temperature: 0.9, maxTokens: 2000 })
  // —— 编辑链实验区（outpaint → inpaint，两级编辑）——
  n.eo = await addGen(cid, 80, 2560, '扩图 · outpaint（1.5x）', { genKind: 'image', prompt: '向四周扩展画面，补全店内两侧货架与吊灯，保持光影一致', size: '1024x1024', edit: { mode: 'outpaint', expand: { xScale: 1.5, yScale: 1.5 } } })
  n.ei = await addGen(cid, 480, 2560, '重绘 · inpaint（已配蒙版）', { genKind: 'image', prompt: '把吧台空位补上一本复古配方笔记', size: '1024x1024', edit: { mode: 'inpaint', maskAssetId: assets.maskImg } })
  // —— 连线（场次1）——
  await link(cid, n.entX, n.img1, 'reference')
  await link(cid, n.entC, n.img1, 'reference')
  await link(cid, n.entX, n.img2, 'reference')
  await link(cid, n.entA, n.img2, 'reference')
  await link(cid, n.entC, n.img2, 'reference')
  await link(cid, n.img1, n.v1, 'first_frame')
  await link(cid, n.img2, n.v2, 'first_frame')
  await link(cid, n.t1, n.au1, 'prompt')
  await link(cid, n.t2, n.au2, 'prompt')
  await link(cid, n.v1, n.c1, 'video')
  await link(cid, n.v2, n.c1, 'video')
  await link(cid, n.au1, n.c1, 'audio')
  await link(cid, n.au2, n.c1, 'audio')
  // —— 连线（场次2）——
  await link(cid, n.entX, n.img3, 'reference')
  await link(cid, n.entC, n.img3, 'reference')
  await link(cid, n.entA, n.img4, 'reference')
  await link(cid, n.entC, n.img4, 'reference')
  await link(cid, n.img3, n.v3, 'first_frame')
  await link(cid, n.img4, n.v4, 'first_frame')
  await link(cid, n.t3, n.au3, 'prompt')
  await link(cid, n.t4, n.au4, 'prompt')
  await link(cid, n.v3, n.c2, 'video')
  await link(cid, n.v4, n.c2, 'video')
  await link(cid, n.au3, n.c2, 'audio')
  await link(cid, n.au4, n.c2, 'audio')
  // —— 连线（场次3）——
  await link(cid, n.entX, n.img5, 'reference')
  await link(cid, n.entA, n.img5, 'reference')
  await link(cid, n.entD, n.img5, 'reference')
  await link(cid, n.entX, n.img6, 'reference')
  await link(cid, n.entD, n.img6, 'reference')
  await link(cid, n.img5, n.v5, 'first_frame')
  await link(cid, n.img6, n.v6, 'first_frame')
  await link(cid, n.t5, n.au5, 'prompt')
  await link(cid, n.t6, n.au6, 'prompt')
  await link(cid, n.v5, n.c3, 'video')
  await link(cid, n.v6, n.c3, 'video')
  await link(cid, n.au5, n.c3, 'audio')
  await link(cid, n.au6, n.c3, 'audio')
  // —— 连线（场次4）——
  await link(cid, n.entX, n.img7, 'reference')
  await link(cid, n.entC, n.img7, 'reference')
  await link(cid, n.entX, n.img8, 'reference')
  await link(cid, n.entA, n.img8, 'reference')
  await link(cid, n.entC, n.img8, 'reference')
  await link(cid, n.img7, n.v7, 'first_frame')
  await link(cid, n.img8, n.v8, 'first_frame')
  await link(cid, n.t7, n.au7, 'prompt')
  await link(cid, n.t8, n.au8, 'prompt')
  await link(cid, n.v7, n.c4, 'video')
  await link(cid, n.v8, n.c4, 'video')
  await link(cid, n.au7, n.c4, 'audio')
  await link(cid, n.au8, n.c4, 'audio')
  // —— 连线（后期总装：三级 compose 链 + 封面 + 文案）——
  await link(cid, n.c1, n.m1, 'video')
  await link(cid, n.c2, n.m1, 'video')
  await link(cid, n.c3, n.m2, 'video')
  await link(cid, n.c4, n.m2, 'video')
  await link(cid, n.m1, n.f, 'video')
  await link(cid, n.m2, n.f, 'video')
  await link(cid, n.entX, n.cover, 'reference')
  await link(cid, n.entA, n.cover, 'reference')
  await link(cid, n.entC, n.cover, 'reference')
  await link(cid, n.t9, n.l1, 'text')
  await link(cid, n.t10, n.l1, 'prompt')
  // —— 连线（编辑链：素材 → outpaint → inpaint）——
  await link(cid, n.aCafe, n.eo, 'source')
  await link(cid, n.eo, n.ei, 'source')
  // —— 序号（全片生产顺序 1-23）——
  const seqPlan: Array<[number, number]> = [
    [n.img1, 1], [n.img2, 2], [n.img3, 3], [n.img4, 4], [n.img5, 5], [n.img6, 6], [n.img7, 7], [n.img8, 8],
    [n.v1, 9], [n.v2, 10], [n.v3, 11], [n.v4, 12], [n.v5, 13], [n.v6, 14], [n.v7, 15], [n.v8, 16],
    [n.c1, 17], [n.c2, 18], [n.c3, 19], [n.c4, 20], [n.m1, 21], [n.m2, 22], [n.f, 23],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（三个嵌套结构：两幕父组 + 后期总装父组）——
  const gS1 = await group(cid, '场次1 · 配方失踪', 'blue', [n.t1, n.t2, n.img1, n.img2, n.au1, n.au2, n.v1, n.v2, n.c1])
  const gS2 = await group(cid, '场次2 · 店内推理', 'blue', [n.t3, n.t4, n.img3, n.img4, n.au3, n.au4, n.v3, n.v4, n.c2])
  const gS3 = await group(cid, '场次3 · 街头追踪', 'blue', [n.t5, n.t6, n.img5, n.img6, n.au5, n.au6, n.v5, n.v6, n.c3])
  const gS4 = await group(cid, '场次4 · 夜归反转', 'blue', [n.t7, n.t8, n.img7, n.img8, n.au7, n.au8, n.v7, n.v8, n.c4])
  await group(cid, '第一幕 · 疑云（场次1-2）', 'amber', undefined, [gS1, gS2])
  await group(cid, '第二幕 · 追寻（场次3-4）', 'amber', undefined, [gS3, gS4])
  const gPost1 = await group(cid, '幕片合成（三级链中段）', 'red', [n.m1, n.m2])
  const gPost2 = await group(cid, '全集与交付', 'red', [n.f, n.cover, n.t9, n.t10, n.l1])
  await group(cid, '后期总装（嵌套父组）', 'purple', undefined, [gPost1, gPost2])
  await group(cid, '素材与实体（一致性资产）', 'gray', [n.s, n.entX, n.entA, n.entC, n.entD, n.aCafe, n.aDusk, n.aMask, n.bgm, n.aSrt])
  await group(cid, '编辑增强实验（outpaint → inpaint）', 'teal', [n.eo, n.ei])
  // —— 双快照：v1 结构就绪 → 调声（au8）→ v2（供对比/恢复教学）——
  await snapshot(cid, '教学快照 · v1 全集结构就绪')
  await api('PATCH', `/nodes/${n.au8}`, { spec: { genKind: 'audio', prompt: '', speed: 1.15, emotion: '坚定——语速稍快，尾音上扬' } })
  await snapshot(cid, '教学快照 · v2 调声后（对比 v1）')
  await setViewport(cid, 0.25)
}

/** 09 场次构建器（单镜头迷你场次）：文案→配音 / 分镜→镜头 / 镜头+配音 → 场次合成 */
interface MiniScene {
  t: number
  img: number
  au: number
  v: number
  c: number
}

async function addMiniScene(
  cid: number,
  x: number,
  y: number,
  text: { title: string; body: string },
  img: { title: string; prompt: string },
  au: { title: string; speed?: number; emotion?: string },
  v: { title: string; prompt: string },
  compTitle: string,
  refs: number[],
): Promise<MiniScene> {
  const t = await addText(cid, x, y, text.title, text.body)
  const imgN = await addGen(cid, x + 400, y, img.title, { genKind: 'image', prompt: img.prompt, size: '1024x1536' })
  const auN = await addGen(cid, x + 800, y, au.title, {
    genKind: 'audio',
    prompt: '',
    speed: au.speed ?? 1,
    ...(au.emotion ? { emotion: au.emotion } : {}),
  })
  const vN = await addGen(cid, x + 1200, y, v.title, { genKind: 'video', prompt: v.prompt, duration: 3, resolution: '720p', aspectRatio: '9:16' })
  const cN = await addGen(cid, x + 1600, y, compTitle, { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  for (const r of refs) await link(cid, r, imgN, 'reference')
  await link(cid, t, auN, 'prompt')
  await link(cid, imgN, vN, 'first_frame')
  await link(cid, vN, cN, 'video')
  await link(cid, auN, cN, 'audio')
  return { t, img: imgN, au: auN, v: vN, c: cN }
}

/** 09 · 季级实战：2 集 → 10 场次 → 四级合成（场次 → 幕 → 集 → 季） */
async function buildCanvas9(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, -1200, 40, '📖 使用说明', [
    '学习目标：从「一集」升级到「一季」——多集结构、更深合成层级与更大场次规模。',
    '',
    '① 三档规模升级（对照 08 画布）：场次 10 > 4、幕 5 > 2、集 2 > 1、合成链 4 级 > 3 级；',
    '② 多集系列：第1集（6 场次 3 幕）与第2集（4 场次 2 幕）各自独立成链，最终在季总片汇合；',
    '③ 四级合成：场次合成 ×10 → 幕片 ×5 → 集片 ×2 → 季总片（compose 逐级链，每级各有转场策略）；',
    '④ 季级统一层：BGM 与字幕仅在季总片注入一次（避免逐集重复混音），配季封面 / 下季预告 / 季宣发文案；',
    '⑤ 嵌套加深：场次组 ⊂ 幕组 ⊂ 集组（三层嵌套；08 为两层），组内折叠后结构一目了然；',
    '⑥ 运行节奏：分镜/配音 → 镜头视频 → 场次片 → 幕片 → 集片 → 季总片；未跑上游时下游显示「暂无成功产物」属正常。',
  ].join('\n'))
  // —— 素材与实体（跨集一致性）——
  n.entX = await addEntityNode(cid, -1200, 520, '角色 · 小杨', entities.xiaoyang)
  n.entA = await addEntityNode(cid, -1200, 840, '角色 · 阿乐', entities.ale)
  n.entY = await addEntityNode(cid, -1200, 1160, '角色 · 小宇（本季新角色）', entities.xiaoyu)
  n.entC = await addEntityNode(cid, -1200, 1480, '场景 · 咖啡馆', entities.cafeScene)
  n.entD = await addEntityNode(cid, -1200, 1800, '场景 · 黄昏街道', entities.duskStreet)
  n.bgm = await addAssetNode(cid, -1200, 2180, 'BGM · 占位音频（季级注入）', assets.bgmWav)
  n.aSrt = await addAssetNode(cid, -1200, 2480, '字幕 · 示例 SRT（季级重钉）', assets.srt)
  // —— 第1集《特殊的学徒》：6 场次 → 3 幕 ——
  // 第一幕 · 请求（场次1-2）
  const s11 = await addMiniScene(cid, 80, 400,
    { title: '台词 · 小宇（请求）', body: '小杨姐……我想学做蛋糕。下周是妈妈的生日，我想亲手做一个给她。' },
    { title: '分镜1 · 街角请求', prompt: '竖屏分镜：黄昏街角，小宇背着画板鼓起勇气拦住刚打烊的小杨，紧张又期待，暮色暖橙' },
    { title: '配音 · 小宇（请求）', speed: 1.0, emotion: '紧张——语速略快，气声明显' },
    { title: '镜头1 · 街角对话', prompt: '跟拍小宇文涩开口，暮色光斑流动，镜头轻推近' },
    '场次合成1 · 请求片（auto 字幕+烧录）',
    [n.entX, n.entY, n.entD])
  const s12 = await addMiniScene(cid, 2080, 400,
    { title: '台词 · 小杨（应允）', body: '好啊——不过做蛋糕没那么简单。明天打烊后，来店里。' },
    { title: '分镜2 · 吧台应允', prompt: '竖屏中景：咖啡馆吧台前，小杨笑着点头应允，阿乐在一旁鼓掌，暖灯氛围' },
    { title: '配音 · 小杨（温和）', speed: 0.95 },
    { title: '镜头2 · 店内交谈', prompt: '吧台对话中景，暖光摇曳，镜头轻摇' },
    '场次合成2 · 应允片（auto 字幕+烧录）',
    [n.entX, n.entC])
  // 第二幕 · 磨练（场次3-4）
  const s13 = await addMiniScene(cid, 80, 1000,
    { title: '台词 · 阿乐（打趣）', body: '手腕要稳，别甩出去——哈哈，奶油都上墙了！' },
    { title: '分镜3 · 奶油乱飞', prompt: '竖屏特写：厨房里小宇手忙脚乱打发奶油，奶油飞溅到围裙，阿乐大笑' },
    { title: '配音 · 阿乐（打趣）', speed: 1.05, emotion: '打趣——语调上扬，带笑' },
    { title: '镜头3 · 厨房手忙脚乱', prompt: '厨房轻喜剧节奏，镜头随奶油飞溅轻甩' },
    '场次合成3 · 磨练片（auto 字幕+烧录）',
    [n.entY, n.entC])
  const s14 = await addMiniScene(cid, 2080, 1000,
    { title: '台词 · 小宇（沮丧）', body: '又糊了……我是不是特别笨？' },
    { title: '分镜4 · 烤糊的蛋糕', prompt: '竖屏近景：烤盘上焦黑的蛋糕胚冒着焦烟，小宇低头垂肩，灯光转冷' },
    { title: '配音 · 小宇（沮丧）', speed: 0.9, emotion: '沮丧——语速慢，气息低' },
    { title: '镜头4 · 烤箱前的沉默', prompt: '固定机位，焦烟缓缓升起，人物沉默' },
    '场次合成4 · 失败片（auto 字幕+烧录）',
    [n.entY, n.entC])
  // 第三幕 · 渐成（场次5-6）
  const s15 = await addMiniScene(cid, 80, 1600,
    { title: '旁白 · 深夜', body: '深夜的咖啡馆还亮着灯——失败率的尽头，是越来越稳的手腕。' },
    { title: '分镜5 · 深夜练习', prompt: '竖屏分镜：深夜咖啡馆后厨暖灯下，小宇独自反复练习打发，小杨在门口默默注视' },
    { title: '配音 · 深夜旁白', speed: 0.95 },
    { title: '镜头5 · 深夜灯光', prompt: '从窗外夜街推近到灯火通明的咖啡馆窗户，缓慢推进' },
    '场次合成5 · 深夜片（auto 字幕+烧录）',
    [n.entY, n.entC])
  const s16 = await addMiniScene(cid, 2080, 1600,
    { title: '台词 · 小杨（鼓励）', body: '看，这次发得刚刚好——明天，就是正式的了。' },
    { title: '分镜6 · 成功的蛋糕胚', prompt: '竖屏特写：金黄的蛋糕胚出炉，小宇与小杨相视而笑，晨光透窗' },
    { title: '配音 · 小杨（鼓励）', speed: 1.0 },
    { title: '镜头6 · 出炉瞬间', prompt: '出炉瞬间轻推，热气升腾，晨光渐亮' },
    '场次合成6 · 渐成片（auto 字幕+烧录）',
    [n.entX, n.entY, n.entC])
  // —— 第2集《生日快乐》：4 场次 → 2 幕 ——
  const s21 = await addMiniScene(cid, 80, 2200,
    { title: '旁白 · 前夜', body: '生日前一晚，三个人把咖啡馆布置成了小小的生日现场。' },
    { title: '分镜7 · 布置现场', prompt: '竖屏分镜：夜晚咖啡馆挂起暖白小灯与手写横幅，三人踩着凳子在布置' },
    { title: '配音 · 前夜旁白', speed: 0.95 },
    { title: '镜头7 · 挂起小灯', prompt: '仰拍视角：暖灯串渐次点亮，镜头缓摇' },
    '场次合成7 · 前夜片（auto 字幕+烧录）',
    [n.entC, n.entY])
  const s22 = await addMiniScene(cid, 2080, 2200,
    { title: '台词 · 小宇（专注）', body: '妈妈喜欢草莓……中间这朵奶油花，是我画过的第一张画。' },
    { title: '分镜8 · 装饰蛋糕', prompt: '竖屏特写：小宇手挤奶油花，蛋糕上摆满草莓，专注的侧脸被暖灯勾勒' },
    { title: '配音 · 小宇（专注）', speed: 0.95 },
    { title: '镜头8 · 裱花特写', prompt: '微距拍裱花过程，奶油花逐渐成形' },
    '场次合成8 · 装饰片（auto 字幕+烧录）',
    [n.entY, n.entC])
  const s23 = await addMiniScene(cid, 80, 2800,
    { title: '台词 · 小杨（神秘）', body: '阿姨，这边请——有个人，等您很久了。' },
    { title: '分镜9 · 妈妈进门', prompt: '竖屏分镜：咖啡馆门口，小杨引着一位女士进门，小宇在烛光后紧张站立' },
    { title: '配音 · 小杨（神秘）', speed: 1.0 },
    { title: '镜头9 · 推门瞬间', prompt: '门铃响起，镜头从烛光蛋糕摇向门口，轻微晃动' },
    '场次合成9 · 惊喜片（auto 字幕+烧录）',
    [n.entX, n.entC])
  const s24 = await addMiniScene(cid, 2080, 2800,
    { title: '台词 · 妈妈（哽咽）', body: '傻孩子……这是妈妈这些年，收到过最好的生日蛋糕。' },
    { title: '分镜10 · 拥抱定格', prompt: '竖屏中景：烛光中妈妈红着眼眶抱住小宇，小杨与阿乐在旁微笑，暖光收尾' },
    { title: '配音 · 妈妈（哽咽）', speed: 0.9, emotion: '哽咽——气息断续，尾音发颤' },
    { title: '镜头10 · 拥抱定格', prompt: '环绕半圈后定格合成合影，灯光渐暖' },
    '场次合成10 · 结局片（auto 字幕+烧录）',
    [n.entY, n.entC])
  // —— 四级链中后段：幕片 ×5 → 集片 ×2 → 季总片 ——
  const m11 = await addGen(cid, 4080, 400, '幕片1-1 · 第1集第一幕（场次1-2）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m12 = await addGen(cid, 4080, 1000, '幕片1-2 · 第1集第二幕（场次3-4）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m13 = await addGen(cid, 4080, 1600, '幕片1-3 · 第1集第三幕（场次5-6）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m21 = await addGen(cid, 4080, 2200, '幕片2-1 · 第2集第一幕（场次1-2）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m22 = await addGen(cid, 4080, 2800, '幕片2-2 · 第2集第二幕（场次3-4）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const ep1 = await addGen(cid, 4480, 1000, '集片 · 第1集成片（三幕联排）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5, fit: 'crop', fps: 30 })
  const ep2 = await addGen(cid, 4480, 2500, '集片 · 第2集成片（两幕联排）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5, fit: 'crop', fps: 30 })
  n.season = await addGen(cid, 4880, 1750, '季总片 · 四级链终点（两集联播+季 BGM/字幕）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 1, bgmAssetId: assets.bgmWav, bgmVolume: 0.35, bgmFade: true, subtitle: 'asset', subtitleAssetId: assets.srt, fit: 'crop', fps: 30 })
  n.cover = await addGen(cid, 4880, 400, '季封面 · 竖版', { genKind: 'image', prompt: '竖版季封面：《元气小杨的一天》第1季——咖啡馆暖灯下三人合影，蛋糕与烛光，上方留白标题区，治愈质感', size: '1024x1536' })
  n.trailer = await addGen(cid, 4880, 760, '下季预告 · 钩子', { genKind: 'video', prompt: '竖版预告：镜头掠过墙上的三人合影，缓缓定格在一把空椅子上，灯光渐暗', duration: 4, resolution: '720p', aspectRatio: '9:16' })
  n.tm = await addText(cid, 4880, 2300, '材料 · 全季卖点与受众', '短剧《元气小杨的一天》第1季（第1-2集）：两集连播，治愈系成长故事；卖点：师徒线 + 生日惊喜反转；受众 18-30 城市青年；平台：短视频。')
  n.tp = await addText(cid, 4880, 2620, '指令 · 季宣发文案', '为本季写宣发文案：不超过 100 字，含季标题、2-3 个话题标签与追更引导。')
  n.l1 = await addGen(cid, 4880, 2940, 'LLM · 季宣发文案生成', { genKind: 'llm', prompt: '', temperature: 0.9, maxTokens: 2000 })
  // —— 连线（四级合成链：场次 → 幕 → 集 → 季）——
  await link(cid, s11.c, m11, 'video')
  await link(cid, s12.c, m11, 'video')
  await link(cid, s13.c, m12, 'video')
  await link(cid, s14.c, m12, 'video')
  await link(cid, s15.c, m13, 'video')
  await link(cid, s16.c, m13, 'video')
  await link(cid, s21.c, m21, 'video')
  await link(cid, s22.c, m21, 'video')
  await link(cid, s23.c, m22, 'video')
  await link(cid, s24.c, m22, 'video')
  await link(cid, m11, ep1, 'video')
  await link(cid, m12, ep1, 'video')
  await link(cid, m13, ep1, 'video')
  await link(cid, m21, ep2, 'video')
  await link(cid, m22, ep2, 'video')
  await link(cid, ep1, n.season, 'video')
  await link(cid, ep2, n.season, 'video')
  // —— 连线（季级交付：封面 / 预告 / 宣发文案）——
  await link(cid, n.entX, n.cover, 'reference')
  await link(cid, n.entY, n.cover, 'reference')
  await link(cid, n.entC, n.cover, 'reference')
  await link(cid, n.entC, n.trailer, 'reference')
  await link(cid, n.tm, n.l1, 'text')
  await link(cid, n.tp, n.l1, 'prompt')
  // —— 序号（全季生产顺序 1-38）——
  const seqPlan: Array<[number, number]> = [
    [s11.img, 1], [s12.img, 2], [s13.img, 3], [s14.img, 4], [s15.img, 5], [s16.img, 6],
    [s21.img, 7], [s22.img, 8], [s23.img, 9], [s24.img, 10],
    [s11.v, 11], [s12.v, 12], [s13.v, 13], [s14.v, 14], [s15.v, 15], [s16.v, 16],
    [s21.v, 17], [s22.v, 18], [s23.v, 19], [s24.v, 20],
    [s11.c, 21], [s12.c, 22], [s13.c, 23], [s14.c, 24], [s15.c, 25], [s16.c, 26],
    [s21.c, 27], [s22.c, 28], [s23.c, 29], [s24.c, 30],
    [m11, 31], [m12, 32], [m13, 33], [m21, 34], [m22, 35],
    [ep1, 36], [ep2, 37], [n.season, 38],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（三层嵌套：场次 ⊂ 幕 ⊂ 集；季级交付独立成组）——
  const gS11 = await group(cid, '第1集 · 场次1 · 街角请求', 'blue', [s11.t, s11.img, s11.au, s11.v, s11.c])
  const gS12 = await group(cid, '第1集 · 场次2 · 店内应允', 'blue', [s12.t, s12.img, s12.au, s12.v, s12.c])
  const gS13 = await group(cid, '第1集 · 场次3 · 第一次打发', 'blue', [s13.t, s13.img, s13.au, s13.v, s13.c])
  const gS14 = await group(cid, '第1集 · 场次4 · 第一炉失败', 'blue', [s14.t, s14.img, s14.au, s14.v, s14.c])
  const gS15 = await group(cid, '第1集 · 场次5 · 深夜练习', 'blue', [s15.t, s15.img, s15.au, s15.v, s15.c])
  const gS16 = await group(cid, '第1集 · 场次6 · 渐入佳境', 'blue', [s16.t, s16.img, s16.au, s16.v, s16.c])
  const gS21 = await group(cid, '第2集 · 场次1 · 生日前夜', 'blue', [s21.t, s21.img, s21.au, s21.v, s21.c])
  const gS22 = await group(cid, '第2集 · 场次2 · 精心装饰', 'blue', [s22.t, s22.img, s22.au, s22.v, s22.c])
  const gS23 = await group(cid, '第2集 · 场次3 · 生日惊喜', 'blue', [s23.t, s23.img, s23.au, s23.v, s23.c])
  const gS24 = await group(cid, '第2集 · 场次4 · 拥抱与约定', 'blue', [s24.t, s24.img, s24.au, s24.v, s24.c])
  const gM11 = await group(cid, '第1集 · 第一幕 · 请求（场次1-2）', 'amber', undefined, [gS11, gS12])
  const gM12 = await group(cid, '第1集 · 第二幕 · 磨练（场次3-4）', 'amber', undefined, [gS13, gS14])
  const gM13 = await group(cid, '第1集 · 第三幕 · 渐成（场次5-6）', 'amber', undefined, [gS15, gS16])
  const gM21 = await group(cid, '第2集 · 第一幕 · 准备（场次1-2）', 'amber', undefined, [gS21, gS22])
  const gM22 = await group(cid, '第2集 · 第二幕 · 惊喜（场次3-4）', 'amber', undefined, [gS23, gS24])
  await group(cid, '第1集《特殊的学徒》（嵌套：集 ⊃ 幕 ⊃ 场次）', 'teal', undefined, [gM11, gM12, gM13])
  await group(cid, '第2集《生日快乐》（嵌套：集 ⊃ 幕 ⊃ 场次）', 'teal', undefined, [gM21, gM22])
  await group(cid, '幕片合成（四级链 · 第2级）', 'red', [m11, m12, m13, m21, m22])
  await group(cid, '集片 · 季总装（四级链 · 第3-4级）', 'purple', [ep1, ep2, n.season, n.cover, n.trailer, n.tm, n.tp, n.l1])
  await group(cid, '素材与实体（跨集一致性）', 'gray', [n.s, n.entX, n.entA, n.entY, n.entC, n.entD, n.bgm, n.aSrt])
  // —— 双快照：v1 季结构就绪 → 调声（s16 配音）→ v2（供对比/恢复教学）——
  await snapshot(cid, '教学快照 · v1 季结构就绪')
  await api('PATCH', `/nodes/${s16.au}`, { spec: { genKind: 'audio', prompt: '', speed: 1.08, emotion: '欣慰——语速缓和，尾音带笑意' } })
  await snapshot(cid, '教学快照 · v2 调声后（对比 v1）')
  await setViewport(cid, 0.22)
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  // 服务可达性检查（给友好报错）
  try {
    await api('GET', '/projects?status=active')
  } catch (err) {
    console.error(`无法连接服务 ${API}，请先启动 server（pnpm dev:server）。原因：${(err as Error).message}`)
    process.exit(1)
  }

  log(`服务地址：${API}`)
  const pid = await ensureProject()
  // 项目简介对齐最新画布数量（幂等：每次写同值）
  await api('PATCH', `/projects/${pid}`, {
    brief: '内置 9 个复杂画布示例（含短剧实战、三级与季级四级合成链），用于学习创作画布的全部核心能力：节点类型 / 端口连线 / 编辑 / 多级合成 / 锁版 / 分组嵌套 / 快照。可直接把玩、运行与改造。',
  })

  log('准备实体（角色 / 场景）…')
  const entities: Entities = {
    xiaoyang: await ensureEntity(pid, 'character', '小杨', {
      summary: '24 岁女生，咖啡与摄影爱好者，本学习实例的固定主角',
      appearance: '齐肩黑短发，圆框眼镜，米色针织衫，笑容温暖',
    }),
    cafeScene: await ensureEntity(pid, 'scene', '清晨咖啡馆', {
      summary: '木质暖色调小咖啡馆，落地窗，门口挂风铃',
      appearance: '暖色木质装修，窗边高脚凳，晨光斜射，浅米色墙面',
    }),
    ale: await ensureEntity(pid, 'character', '阿乐', {
      summary: '小杨的常客朋友，率直热心，短剧第1集的对话搭子',
      appearance: '寸头短发，浅灰卫衣，笑起来露虎牙',
    }),
    duskStreet: await ensureEntity(pid, 'scene', '黄昏街道', {
      summary: '咖啡馆门外的街道，傍晚暖橙天色，街灯初亮',
      appearance: '暮色街道，暖橙天空，玻璃橱窗反光，氛围安静',
    }),
    xiaoyu: await ensureEntity(pid, 'character', '小宇', {
      summary: '第1季新角色：想为妈妈亲手做生日蛋糕的年轻人，拜小杨为师',
      appearance: '清瘦少年，深蓝连帽衫，背着旧画板，眼神倔强又温柔',
    }),
  }

  log('上传占位素材（5 图 + 静音 WAV + 示例 SRT）…')
  const pngCafe = makeScenePng({ w: 1280, h: 720, top: [255, 236, 210], bottom: [232, 195, 158], light: [255, 224, 163] })
  const pngDusk = makeScenePng({ w: 1280, h: 720, top: [255, 158, 107], bottom: [93, 75, 122], light: [255, 214, 165] })
  const pngCamera = makeScenePng({ w: 768, h: 768, top: [232, 246, 239], bottom: [125, 206, 160], light: [255, 255, 255] })
  const pngXiaoyang = makeScenePng({ w: 768, h: 1024, top: [214, 234, 248], bottom: [127, 179, 213], light: [255, 255, 255] })
  const pngAle = makeScenePng({ w: 768, h: 1024, top: [255, 240, 220], bottom: [198, 138, 92], light: [255, 255, 255] })
  const pngXiaoyu = makeScenePng({ w: 768, h: 1024, top: [225, 236, 255], bottom: [146, 146, 202], light: [255, 255, 255] })
  const pngMask = makeMaskPng(1024, 1024)
  const assets: Assets = {
    cafeImg: await uploadMedia(pid, '学习素材-清晨咖啡馆.png', pngCafe, 'image/png', 'source'),
    duskImg: await uploadMedia(pid, '学习素材-黄昏街景.png', pngDusk, 'image/png', 'source'),
    cameraImg: await uploadMedia(pid, '学习素材-复古相机.png', pngCamera, 'image/png', 'source'),
    maskImg: await uploadMedia(pid, '学习素材-蒙版占位图.png', pngMask, 'image/png', 'mask'),
    bgmWav: await uploadMedia(pid, '学习素材-BGM占位-静音.wav', makeSilentWav(2), 'audio/wav', 'bgm'),
    srt: await uploadMedia(pid, '学习字幕-示例.srt', Buffer.from(SRT_TEXT, 'utf8'), 'text/plain', 'source'),
  }
  log(`  素材就绪：咖啡馆图 #${assets.cafeImg}、黄昏街景 #${assets.duskImg}、复古相机 #${assets.cameraImg}、蒙版 #${assets.maskImg}、BGM #${assets.bgmWav}、字幕 #${assets.srt}`)

  // 实体定妆照（内容 sha256 去重 + 挂接合并，天然幂等）：小杨用专属立绘，场景复用咖啡馆图资产
  log('补实体定妆照…')
  await uploadEntityRef(entities.xiaoyang, '学习素材-角色小杨立绘.png', pngXiaoyang, 'image/png')
  await uploadEntityRef(entities.cafeScene, '学习素材-清晨咖啡馆.png', pngCafe, 'image/png')
  await uploadEntityRef(entities.ale, '学习素材-角色阿乐立绘.png', pngAle, 'image/png')
  await uploadEntityRef(entities.duskStreet, '学习素材-黄昏街景.png', pngDusk, 'image/png')
  await uploadEntityRef(entities.xiaoyu, '学习素材-角色小宇立绘.png', pngXiaoyu, 'image/png')

  const builders: Array<{ name: string; build: (cid: number) => Promise<void> }> = [
    { name: '01 · 入门：文本 → 图片生成', build: (cid) => buildCanvas1(cid) },
    { name: '02 · 参考图：多参考 / 局部重绘 / 扩图', build: (cid) => buildCanvas2(cid, assets) },
    { name: '03 · 视频：首尾帧与运镜', build: (cid) => buildCanvas3(cid, assets, entities) },
    { name: '04 · 配音 + 合成：成片流水线', build: (cid) => buildCanvas4(cid, assets) },
    { name: '05 · LLM 文本处理链', build: (cid) => buildCanvas5(cid) },
    { name: '06 · 综合实战：嵌套分组与全要素', build: (cid) => buildCanvas6(cid, assets, entities) },
    { name: '07 · 短剧实战：《元气小杨的一天》第1集', build: (cid) => buildCanvas7(cid, assets, entities) },
    { name: '08 · 短剧实战·全集：4 场次 → 2 幕 → 三级合成', build: (cid) => buildCanvas8(cid, assets, entities) },
    { name: '09 · 季级实战：2 集 → 10 场次 → 四级合成', build: (cid) => buildCanvas9(cid, assets, entities) },
  ]

  const results: Array<{ name: string; id: number }> = []
  for (const b of builders) {
    const { id, needFill } = await ensureCanvas(pid, b.name)
    if (needFill) {
      await b.build(id)
      const doc = await api('GET', `/canvases/${id}`)
      log(`✓ 画布 #${id}「${b.name}」：${doc.nodes.length} 节点 / ${doc.edges.length} 连线 / ${doc.groups.length} 分组`)
    } else {
      log(`= 画布 #${id}「${b.name}」已存在且非空，跳过`)
    }
    results.push({ name: b.name, id })
  }

  log('')
  log(`完成！项目「${PROJECT_NAME}」(#${pid}) 下共 ${results.length} 个画布：`)
  for (const r of results) {
    log(`  ${r.name}  →  ${BASE}/creation?project=${pid}&canvas=${r.id}`)
  }
  log('（Web 开发端口画面：http://127.0.0.1:5273/creation?project=' + pid + '&canvas=' + results[0]!.id + ' 起）')
}

main().catch((err) => {
  console.error(`[seed] 失败：${(err as Error).message}`)
  process.exit(1)
})
