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
 *
 * 结构（行为零变更切分，本文件为编排入口 + 01-06 基础画布构建器）：
 *   - seed-learning-api.ts：HTTP 工具 + 领域操作 + 共享类型 / 常量
 *   - seed-learning-media.ts：占位素材生成（PNG / WAV / SRT；零依赖）
 *   - seed-learning-canvases-drama.ts：07-09 短剧实战 / 全集 / 季级画布构建器
 */
/// <reference types="node" />
import {
  addAssetNode,
  addEntityNode,
  addGen,
  addText,
  API,
  api,
  BASE,
  ensureCanvas,
  ensureEntity,
  ensureProject,
  group,
  link,
  log,
  PROJECT_NAME,
  setSeq,
  setViewport,
  snapshot,
  uploadEntityRef,
  uploadMedia,
  type Assets,
  type Entities,
  type NodeIds,
} from './seed-learning-api'
import { makeMaskPng, makeScenePng, makeSilentWav, SRT_TEXT } from './seed-learning-media'
import { buildCanvas7, buildCanvas8, buildCanvas9 } from './seed-learning-canvases-drama'

// ---------- 六个基础教学画布（01-06 基础串联；07-09 见 seed-learning-canvases-drama.ts） ----------

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
