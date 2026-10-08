/**
 * 治愈小短剧 · 多集制作画布 seed —— 为项目「治愈小短剧」创建《小小杨的日常》第 1-3 集制作画布。
 *
 * 目的：把项目已有资产（角色实体：小小杨 / 爸爸 / 妈妈 / 图图）变成可直接开工的多集制作工作台：
 * 3 集 × 2 场次 × 2 镜 → 场次片 ×6 → 集片 ×3 → 合集片（三级合成链），
 * 每镜标准工序「台词 → 配音 / 分镜 → 镜头」，BGM 注入集片，另配封面与发布文案 LLM 链。
 * 新增 2 个场景实体（温馨客厅 / 婴儿房）用于跨集场景一致性。
 *
 * 实体参考图策略：不写任何参考图——角色实体沿用库中已有真实参考图；
 * 场景实体等用户在实体库上传实拍图（未传时仅节点提示「实体无参考图」，不阻断运行；
 * 占位渐变图会作为参考图进入真实生成输入，故一律不挂）。
 *
 * 方式：纯 HTTP API 驱动（服务需已启动，默认 http://127.0.0.1:3001）。
 * 幂等：项目按名定位（找不到则报错，不新建）；实体按名复用/新建；BGM 素材 sha256 去重；
 * 画布已有节点则跳过填充。
 *
 * 运行：pnpm --filter @acs/server exec tsx scripts/seed-healing-series-canvas.ts
 * 可用环境变量 CSTUDIO_BASE_URL 覆盖服务地址。
 */
/// <reference types="node" />

const BASE = process.env.CSTUDIO_BASE_URL ?? 'http://127.0.0.1:3001'
const API = `${BASE}/api/v1`
const PROJECT_NAME = '治愈小短剧'
const CANVAS_NAME = '多集制作 · 《小小杨的日常》第1-3集'

function log(msg: string): void {
  console.log(`[healing-seed] ${msg}`)
}

// ---------- HTTP 工具（与教学 seed 同构） ----------

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

// ---------- 占位素材生成（WAV；零依赖） ----------

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

// ---------- 领域操作 ----------

async function findProject(): Promise<number> {
  const list = await api('GET', '/projects?status=active')
  const found = (list.items as any[]).find((p) => p.name === PROJECT_NAME)
  if (!found) {
    throw new Error(`未找到活跃项目「${PROJECT_NAME}」——请确认项目存在（不做自动新建，避免误建重复项目）`)
  }
  log(`复用项目 #${found.id}（${PROJECT_NAME}）`)
  return found.id as number
}

async function ensureEntity(projectId: number, kind: string, name: string, extra: Record<string, unknown>): Promise<number> {
  const list = await api('GET', `/entities?project_id=${projectId}&kind=${kind}`)
  const found = (list.items as any[]).find((e) => e.name === name)
  if (found) {
    log(`  复用实体【${kind}】${name} #${found.id}`)
    return found.id as number
  }
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

// ---------- 内部类型 ----------

interface NodeIds {
  [key: string]: number
}

interface Assets {
  bgmWav: number
}

interface Entities {
  baby: number
  papa: number
  mama: number
  tutu: number
  room: number
  nursery: number
}

/** 单集场次构建器：台词→配音 / 分镜→镜头 / 镜头+配音 → 场次合成（2 镜 2 配音，对齐合法） */
interface ShotSpec {
  t: { title: string; body: string }
  img: { title: string; prompt: string; refs: number[] }
  au: { title: string; speed?: number; emotion?: string }
  v: { title: string; prompt: string }
}

async function addScene(
  cid: number,
  x: number,
  y: number,
  compTitle: string,
  compY: number,
  shots: ShotSpec[],
): Promise<{ all: number[]; comp: number }> {
  const all: number[] = []
  const vs: number[] = []
  const aus: number[] = []
  for (let i = 0; i < shots.length; i += 1) {
    const s = shots[i]!
    const yy = y + i * 320
    const t = await addText(cid, x, yy, s.t.title, s.t.body)
    const img = await addGen(cid, x + 400, yy, s.img.title, { genKind: 'image', prompt: s.img.prompt, size: '1024x1536' })
    const au = await addGen(cid, x + 800, yy, s.au.title, {
      genKind: 'audio',
      prompt: '',
      speed: s.au.speed ?? 1,
      ...(s.au.emotion ? { emotion: s.au.emotion } : {}),
    })
    const v = await addGen(cid, x + 1200, yy, s.v.title, {
      genKind: 'video',
      prompt: s.v.prompt,
      duration: 3,
      resolution: '720p',
      aspectRatio: '9:16',
    })
    for (const r of s.img.refs) await link(cid, r, img, 'reference')
    await link(cid, t, au, 'prompt')
    await link(cid, img, v, 'first_frame')
    all.push(t, img, au, v)
    aus.push(au)
    vs.push(v)
  }
  const comp = await addGen(cid, x + 1600, compY, compTitle, {
    genKind: 'compose',
    prompt: '',
    align: true,
    subtitle: 'auto',
    burnSubtitles: true,
    fit: 'pad',
    fps: 30,
  })
  for (const v of vs) await link(cid, v, comp, 'video')
  for (const a of aus) await link(cid, a, comp, 'audio')
  all.push(comp)
  return { all, comp }
}

// ---------- 画布构建 ----------

async function buildMultiEpCanvas(cid: number, assets: Assets, ent: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, -1200, 40, '📖 多集制作工作台 · 使用说明', [
    '《小小杨的日常》第 1-3 集 —— 萌宝家庭治愈微短剧（单集约 40s，竖屏 9:16）。',
    '',
    '① 三集并行生产：每集 2 场次 × 2 镜 → 场次片 → 集片；三集在右侧汇总为「合集片」，可直接逐级运行；',
    '② 工序：台词 → 配音（prompt 端口）/ 分镜图 → 镜头视频（first_frame 端口）→ 场次合成（对齐+字幕烧录）→ 集片（转场+BGM）→ 合集片；',
    '③ 一致性：分镜图经 reference 端口引用角色（小小杨/爸爸/妈妈/图图）与场景（温馨客厅/婴儿房）实体，生成时自动带入设定；',
    '④ 交付独立：每集集片可单独发布；BGM 经参数注入集片（画布上以素材节点展示，无需连线，属正常）；',
    '⑤ 运行节奏：分镜/配音 → 镜头视频 → 场次片 → 集片 → 合集片；未跑上游时下游显示「暂无成功产物」属正常；',
    '⑥ 快照：v1 三集结构就绪 / v2 调声后，可在快照面板对比与恢复。',
  ].join('\n'))
  // —— 素材与实体（跨集一致性）——
  n.entBaby = await addEntityNode(cid, -1200, 560, '角色 · 小小杨（8-10 个月男宝）', ent.baby)
  n.entPapa = await addEntityNode(cid, -1200, 880, '角色 · 爸爸（温和奶爸）', ent.papa)
  n.entMama = await addEntityNode(cid, -1200, 1200, '角色 · 妈妈（温柔女性）', ent.mama)
  n.entTutu = await addEntityNode(cid, -1200, 1520, '角色 · 图图（暹罗猫）', ent.tutu)
  n.entRoom = await addEntityNode(cid, -1200, 1840, '场景 · 温馨客厅', ent.room)
  n.entNur = await addEntityNode(cid, -1200, 2160, '场景 · 婴儿房', ent.nursery)
  n.bgm = await addAssetNode(cid, -1200, 2480, 'BGM · 占位音频（集片注入）', assets.bgmWav)
  // —— 第1集《清晨的咿呀》：场次A 婴儿房 + 场次B 客厅早安 ——
  const s1 = await addScene(cid, 80, 400, '场次片A · 清晨咿呀（对齐+字幕）', 560, [
    {
      t: { title: '旁白 · 开场', body: '清晨六点，家里第一个醒来的，总是他。' },
      img: { title: '分镜1 · 床栏张望', prompt: '竖屏分镜：清晨婴儿房，8 个月大的男婴小小杨扶着婴儿床栏站起来，晨光透过纱帘洒进房间，画面柔和安静', refs: [n.entBaby, n.entNur] },
      au: { title: '配音 · 开场旁白', speed: 0.95 },
      v: { title: '镜头1 · 睁眼起身', prompt: '镜头从婴儿床边缓缓推近，小小杨抓着床栏摇晃站起，晨光微微流动' },
    },
    {
      t: { title: '台词 · 小小杨（咿呀）', body: '（咿咿呀呀）ba——ba——' },
      img: { title: '分镜2 · 咿呀学语', prompt: '竖屏特写：小小杨趴在床栏上朝门口咿呀叫，圆圆的脸蛋，眼睛亮亮的，晨光勾出毛茸茸的轮廓', refs: [n.entBaby, n.entNur] },
      au: { title: '配音 · 小小杨咿呀', speed: 1, emotion: '软萌——咿呀软糯，尾音上扬' },
      v: { title: '镜头2 · 咿呀呼唤', prompt: '特写镜头：小小杨朝门口咿呀挥手，镜头轻微手持晃动，画面温柔' },
    },
  ])
  const s2 = await addScene(cid, 2080, 400, '场次片B · 早安拥抱（对齐+字幕）', 560, [
    {
      t: { title: '台词 · 爸爸（画外）', body: '来了来了——爸爸的小闹钟先响了。' },
      img: { title: '分镜3 · 推门进门', prompt: '竖屏中景：年轻奶爸披着睡衣推开婴儿房门走进来，头发微微翘起，笑着走向床边，晨光斜照', refs: [n.entPapa, n.entBaby, n.entNur] },
      au: { title: '配音 · 爸爸（画外）', speed: 1.05, emotion: '困意——气声含糊，随即精神起来' },
      v: { title: '镜头3 · 推门走近', prompt: '跟拍爸爸推门走向婴儿床，脚步轻快，晨光在人身上流转' },
    },
    {
      t: { title: '台词 · 爸爸（温柔）', body: '早安，我的小太阳。' },
      img: { title: '分镜4 · 额头相碰', prompt: '竖屏特写：爸爸把小小杨抱在怀里，两人额头轻轻碰在一起相视而笑，逆光勾勒温暖轮廓', refs: [n.entPapa, n.entBaby, n.entRoom] },
      au: { title: '配音 · 爸爸（温柔）', speed: 0.95 },
      v: { title: '镜头4 · 额头相碰', prompt: '额头相碰的瞬间，镜头缓缓环绕半圈，暖光包裹' },
    },
  ])
  const f1 = await addGen(cid, 4080, 560, '集片1 · 《清晨的咿呀》（转场+BGM）', {
    genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5,
    bgmAssetId: assets.bgmWav, bgmVolume: 0.3, bgmFade: true, fit: 'crop', fps: 30,
  })
  // —— 第2集《图图的位置》：场次A 客厅午后 + 场次B 婴儿房午睡 ——
  const s3 = await addScene(cid, 80, 1500, '场次片C · 越靠越近（对齐+字幕）', 1660, [
    {
      t: { title: '旁白 · 午后', body: '图图最近有个新习惯——离那个会动的小家伙越来越近。' },
      img: { title: '分镜5 · 沙发背旁观', prompt: '竖屏分镜：午后客厅，暹罗猫图图蹲在沙发背上，居高临下看地毯上玩积木的宝宝，尾巴轻轻摆动', refs: [n.entTutu, n.entBaby, n.entRoom] },
      au: { title: '配音 · 午后旁白', speed: 0.95 },
      v: { title: '镜头5 · 沙发背远望', prompt: '从沙发背上的图图视角缓缓下摇，落在地毯上玩积木的宝宝' },
    },
    {
      t: { title: '台词 · 妈妈（轻笑）', body: '我就说嘛，它这是寸步不离。' },
      img: { title: '分镜6 · 爪子搭上膝盖', prompt: '竖屏特写：图图从沙发跳到宝宝身边，把爪子轻轻搭上他的膝盖，试探又小心', refs: [n.entTutu, n.entBaby, n.entRoom] },
      au: { title: '配音 · 妈妈（轻笑）', speed: 1, emotion: '轻笑——语调轻软，带一丝笑意' },
      v: { title: '镜头6 · 轻轻靠近', prompt: '镜头跟随图图轻手轻脚靠近，爪子搭上膝盖的瞬间放慢' },
    },
  ])
  const s4 = await addScene(cid, 2080, 1500, '场次片D · 最近的位置（对齐+字幕）', 1660, [
    {
      t: { title: '旁白 · 转场', body: '午睡时间到——' },
      img: { title: '分镜7 · 床边守卫', prompt: '竖屏中景：婴儿床边，图图蹲坐在地毯上守卫，宝宝在床上睡得香甜，窗光光斑静静移动', refs: [n.entTutu, n.entBaby, n.entNur] },
      au: { title: '配音 · 转场旁白', speed: 0.95 },
      v: { title: '镜头7 · 光斑守卫', prompt: '镜头缓缓横移过婴儿床边，图图端坐守卫，光斑在画面里静静移动' },
    },
    {
      t: { title: '旁白 · 收尾', body: '它选了一个离他最近的位置。' },
      img: { title: '分镜8 · 一起睡着', prompt: '竖屏特写：图图蜷在床边的软垫上睡着了，尾巴轻轻卷起，画面极为安静', refs: [n.entTutu, n.entBaby, n.entNur] },
      au: { title: '配音 · 收尾旁白', speed: 0.9 },
      v: { title: '镜头8 · 一起入睡', prompt: '特写缓慢推近蜷睡的图图，呼吸起伏，画面渐静' },
    },
  ])
  const f2 = await addGen(cid, 4080, 1660, '集片2 · 《图图的位置》（转场+BGM）', {
    genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5,
    bgmAssetId: assets.bgmWav, bgmVolume: 0.3, bgmFade: true, fit: 'crop', fps: 30,
  })
  // —— 第3集《第一步》：场次A 客厅傍晚 + 场次B 迈步瞬间 ——
  const s5 = await addScene(cid, 80, 2500, '场次片E · 两步之外（对齐+字幕）', 2660, [
    {
      t: { title: '旁白 · 傍晚', body: '扶着小沙发，他已经站得很稳了。' },
      img: { title: '分镜9 · 扶沙发站立', prompt: '竖屏分镜：傍晚暖光客厅，小小杨扶着沙发边缘站着，小脚丫踩在地毯上，身体微微摇晃', refs: [n.entBaby, n.entRoom] },
      au: { title: '配音 · 傍晚旁白', speed: 0.95 },
      v: { title: '镜头9 · 摇摇晃晃', prompt: '镜头贴着小小杨摇晃的视线，沙发边缘与地毯之间，光影柔软' },
    },
    {
      t: { title: '台词 · 爸爸（鼓励）', body: '来——到爸爸这儿来。' },
      img: { title: '分镜10 · 两步之外', prompt: '竖屏中景：爸爸蹲在两步之外张开双臂，眼里全是期待，妈妈在画面边缘屏息注视', refs: [n.entPapa, n.entBaby, n.entRoom] },
      au: { title: '配音 · 爸爸（鼓励）', speed: 0.95 },
      v: { title: '镜头10 · 张开的双臂', prompt: '从爸爸身后越过肩膀望去，小小杨立在夕阳里，镜头浅景深' },
    },
  ])
  const s6 = await addScene(cid, 2080, 2500, '场次片F · 迈步瞬间（对齐+字幕）', 2660, [
    {
      t: { title: '旁白 · 屏息', body: '松开手的那一秒，全家屏住了呼吸。' },
      img: { title: '分镜11 · 迈出第一步', prompt: '竖屏特写：小脚丫离开沙发，颤巍巍踩出第一步，地毯纹理与侧逆光，慢动作感', refs: [n.entBaby, n.entRoom] },
      au: { title: '配音 · 屏息旁白', speed: 0.9 },
      v: { title: '镜头11 · 第一步', prompt: '低机位贴地跟拍小脚丫迈步，重心前倾的瞬间真实而小心' },
    },
    {
      t: { title: '台词 · 妈妈（惊喜）', body: '他会的！他走过来了！' },
      img: { title: '分镜12 · 扑进怀里', prompt: '竖屏中景：小小杨跌跌撞撞扑进爸爸张开的双臂，妈妈在旁边鼓掌笑出声，逆光剪影温暖', refs: [n.entPapa, n.entMama, n.entBaby, n.entRoom] },
      au: { title: '配音 · 妈妈（惊喜）', speed: 1.05, emotion: '惊喜——音调上扬，语速轻快' },
      v: { title: '镜头12 · 扑进怀里', prompt: '扑进怀抱的一瞬，镜头轻晃，一家人的笑声充满画面，暖光收尾' },
    },
  ])
  const f3 = await addGen(cid, 4080, 2660, '集片3 · 《第一步》（转场+BGM）', {
    genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5,
    bgmAssetId: assets.bgmWav, bgmVolume: 0.3, bgmFade: true, fit: 'crop', fps: 30,
  })
  // —— 合集与交付：合集片 / 封面 / 发布文案 ——
  n.fAll = await addGen(cid, 4480, 1060, '合集片 · 三集联播（合集版）', {
    genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.8, fit: 'crop', fps: 30,
  })
  n.cover = await addGen(cid, 4480, 400, '封面 · 系列全家福（竖版）', {
    genKind: 'image',
    prompt: '竖版系列封面：《小小杨的日常》——暖光客厅里爸爸举起咯咯笑的小小杨，妈妈在旁微笑，暹罗猫图图蹲在沙发背上，上方留白标题区，治愈柔光质感',
    size: '1024x1536',
  })
  n.tm = await addText(cid, 4480, 1560, '材料 · 系列卖点与受众', '微短剧《小小杨的日常》第 1-3 集：萌宝家庭治愈日常（清晨咿呀 / 图图的守候 / 学步第一步）；受众 18-35 高压人群；平台：抖音；风格：低冲突、温柔、留白。')
  n.tp = await addText(cid, 4480, 1880, '指令 · 合集发布文案', '为《小小杨的日常》第 1-3 集合集写发布文案：不超过 100 字，含系列名、2-3 个话题标签与追更引导。')
  n.l1 = await addGen(cid, 4880, 1720, 'LLM · 合集文案生成', { genKind: 'llm', prompt: '', temperature: 0.8, maxTokens: 1500 })
  // —— 连线（三级合成链：场次片 → 集片 → 合集片）——
  await link(cid, s1.comp, f1, 'video')
  await link(cid, s2.comp, f1, 'video')
  await link(cid, s3.comp, f2, 'video')
  await link(cid, s4.comp, f2, 'video')
  await link(cid, s5.comp, f3, 'video')
  await link(cid, s6.comp, f3, 'video')
  await link(cid, f1, n.fAll, 'video')
  await link(cid, f2, n.fAll, 'video')
  await link(cid, f3, n.fAll, 'video')
  // —— 连线（交付：封面 / 文案）——
  await link(cid, n.entBaby, n.cover, 'reference')
  await link(cid, n.entPapa, n.cover, 'reference')
  await link(cid, n.entMama, n.cover, 'reference')
  await link(cid, n.entTutu, n.cover, 'reference')
  await link(cid, n.entRoom, n.cover, 'reference')
  await link(cid, n.tm, n.l1, 'text')
  await link(cid, n.tp, n.l1, 'prompt')
  // —— 序号（生产顺序：分镜 1-12 → 镜头 13-24 → 场次片 25-30 → 集片 31-33 → 合集片 34）——
  const seqPlan: Array<[number, number]> = [
    [s1.all[1]!, 1], [s1.all[5]!, 2], [s2.all[1]!, 3], [s2.all[5]!, 4],
    [s3.all[1]!, 5], [s3.all[5]!, 6], [s4.all[1]!, 7], [s4.all[5]!, 8],
    [s5.all[1]!, 9], [s5.all[5]!, 10], [s6.all[1]!, 11], [s6.all[5]!, 12],
    [s1.all[3]!, 13], [s1.all[7]!, 14], [s2.all[3]!, 15], [s2.all[7]!, 16],
    [s3.all[3]!, 17], [s3.all[7]!, 18], [s4.all[3]!, 19], [s4.all[7]!, 20],
    [s5.all[3]!, 21], [s5.all[7]!, 22], [s6.all[3]!, 23], [s6.all[7]!, 24],
    [s1.comp, 25], [s2.comp, 26], [s3.comp, 27], [s4.comp, 28], [s5.comp, 29], [s6.comp, 30],
    [f1, 31], [f2, 32], [f3, 33], [n.fAll, 34],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（三层嵌套：场次 ⊂ 集 ⊂ 系列；交付与素材独立成组）——
  const gS1 = await group(cid, '第1集 · 场次A · 清晨咿呀', 'blue', s1.all)
  const gS2 = await group(cid, '第1集 · 场次B · 早安拥抱', 'blue', s2.all)
  const gE1 = await group(cid, '第1集《清晨的咿呀》', 'amber', [f1], [gS1, gS2])
  const gS3 = await group(cid, '第2集 · 场次A · 越靠越近', 'blue', s3.all)
  const gS4 = await group(cid, '第2集 · 场次B · 最近的位置', 'blue', s4.all)
  const gE2 = await group(cid, '第2集《图图的位置》', 'amber', [f2], [gS3, gS4])
  const gS5 = await group(cid, '第3集 · 场次A · 两步之外', 'blue', s5.all)
  const gS6 = await group(cid, '第3集 · 场次B · 迈步瞬间', 'blue', s6.all)
  const gE3 = await group(cid, '第3集《第一步》', 'amber', [f3], [gS5, gS6])
  await group(cid, '《小小杨的日常》多集父组（第 1-3 集）', 'teal', undefined, [gE1, gE2, gE3])
  await group(cid, '合集与交付（封面 / 文案）', 'purple', [n.fAll, n.cover, n.tm, n.tp, n.l1])
  await group(cid, '素材与实体（跨集一致性）', 'gray', [n.s, n.entBaby, n.entPapa, n.entMama, n.entTutu, n.entRoom, n.entNur, n.bgm])
  // —— 双快照：v1 三集结构就绪 → 调声（第3集妈妈惊喜配音）→ v2 ——
  await snapshot(cid, '快照 · v1 三集结构就绪')
  await api('PATCH', `/nodes/${s6.all[6]}`, {
    spec: { genKind: 'audio', prompt: '', speed: 1.1, emotion: '惊喜——音调上扬，气息发亮，尾音带笑意' },
  })
  await snapshot(cid, '快照 · v2 调声后（对比 v1）')
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
  const pid = await findProject()

  log('准备实体（角色复用 + 场景补齐）…')
  const ent: Entities = {
    baby: await ensureEntity(pid, 'character', '小小杨', {
      summary: '治愈小短剧主角，8-10 个月刚学步的男婴；全家情绪中心，负责「萌」与「被治愈」。',
      appearance: '圆脸大眼睛的男宝，浅栗色软发，米白连体衣，笑起来有两个小梨涡',
    }),
    papa: await ensureEntity(pid, 'character', '爸爸', {
      summary: '小小杨的父亲，30 岁上下的温和青年奶爸；治愈系叙述的主要视角与陪伴者。',
      appearance: '寸头短发，亚麻色家居衫，眼神温和，笑起来眼角有细纹',
    }),
    mama: await ensureEntity(pid, 'character', '妈妈', {
      summary: '小小杨的母亲，28-32 岁的温柔女性；家庭情绪的稳定器。',
      appearance: '及肩黑发半扎，燕麦色针织衫，气质安静柔和',
    }),
    tutu: await ensureEntity(pid, 'character', '图图', {
      summary: '家中养的暹罗猫，与小小杨一起长大的「毛孩子」，负责调皮与治愈桥段。',
      appearance: '暹罗猫：奶油色身躯、深色面罩与四爪，湛蓝眼睛，尾巴尖微微卷',
    }),
    room: await ensureEntity(pid, 'scene', '温馨客厅', {
      summary: '家中的客厅：萌宝家庭日常的主要场景，暖色调、舒适明亮。',
      appearance: '暖米色墙面、布艺沙发、木质地板、落地窗与绿植、午后柔光',
    }),
    nursery: await ensureEntity(pid, 'scene', '婴儿房', {
      summary: '家中的婴儿房：小小杨的卧室，用于睡觉与清晨戏份，安静柔和。',
      appearance: '浅青灰墙面、木质婴儿床、白色纱帘、地毯与软垫、晨光通透',
    }),
  }

  log('上传占位素材（静音 BGM）…')
  const assets: Assets = {
    bgmWav: await uploadMedia(pid, '占位-BGM-静音.wav', makeSilentWav(2), 'audio/wav', 'bgm'),
  }
  log(`  素材就绪：BGM #${assets.bgmWav}（sha256 去重）`)
  log('实体参考图：跳过不挂（角色沿用库中真实图；场景待用户上传实拍图，占位图会污染生成输入）')

  const { id, needFill } = await ensureCanvas(pid, CANVAS_NAME)
  if (needFill) {
    await buildMultiEpCanvas(id, assets, ent)
    const doc = await api('GET', `/canvases/${id}`)
    log(`✓ 画布 #${id}「${CANVAS_NAME}」：${doc.nodes.length} 节点 / ${doc.edges.length} 连线 / ${doc.groups.length} 分组`)
  } else {
    log(`= 画布 #${id}「${CANVAS_NAME}」已存在且非空，跳过填充`)
  }

  log('')
  log(`完成！打开地址：${BASE}/creation?project=${pid}&canvas=${id}`)
  log(`（Web 开发端口画面：http://127.0.0.1:5273/creation?project=${pid}&canvas=${id}）`)
}

main().catch((err) => {
  console.error(`[healing-seed] 失败：${(err as Error).message}`)
  process.exit(1)
})
