/**
 * M55 探针（本地全类型模型接入：LocalAI + ComfyUI 双轨）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m55.ts [--section=pure|live]
 *
 * 隔离：isolatedEnv('m55') 一次性临时目录（独立 studio.db），须先于任何 src 动态 import。
 * 全程零真实 HTTP：live 节以 globalThis.fetch 桩做全链路契约测试（本地服务无需真实 Key/付费）。
 *
 * 断言面（docs/records/local-model-integration-spec.md §5）：
 *  - registry：initDb 后 5 新目录行已 seed；kit 注册表 ⊇ 宿主本地轨目录（image/video/music 派发命中 + provider 串）；video-caps 背书档位（localai 保守档 / comfyui fail-closed null）。
 *  - pure：buildLocalAIImageBody（txt2img 强制 b64_json / ref 带 ref_images）、parseLocalAIImageResponse（url|b64 双形态）、localAIVideoRootUrl（剥 /v1）、buildLocalAIVideoBody（duration→seconds/num_frames、start_image、WxH）、parseLocalAIVideoResponse、buildComfyUIWorkflow（占位符注入）、extractComfyUIOutputFiles（image/video + video 回落 images）、injectComfyUIInputNode（缺失节点 fail-closed）、localAIMusicUrl/buildLocalAIMusicBody。
 *  - live：LocalAI 图/视频请求出线（端点路径 + b64 解析 + 空 Key 不带 Authorization）、probe（/v1/models）、ComfyUI /prompt→/history→/view 三段链路 + 轮询 + probe（/system_stats）、LocalAI 音乐二进制直收。
 *
 * 退出码：0=全绿；1=有 FAIL。断言文案不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m55')
const kit = await import('@agencys/ai-provider-kit')

const SECTIONS = ['pure', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m55')
const checker: Checker = makeChecker(log)
const check = checker.check

// 最小 PNG（89 50 4E 47 魔数头）base64，供 b64_json 直收形态断言
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
const WAV_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x24])

await runSections({
  log,
  title: 'M55',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    const { db } = await import('../src/db')
    const { apiProviders } = await import('../src/db/schema')
    const rows = await db.select().from(apiProviders)
    const byKey = new Map(rows.map((r) => [r.key, r]))
    // —— 目录行 seed（本地轨私有协议能力逐行）——
    for (const [key, st, vendor] of [
      ['localai_image', 'image', 'localai'],
      ['localai_video', 'video', 'localai'],
      ['localai_music', 'music', 'localai'],
      ['comfyui_image', 'image', 'comfyui'],
      ['comfyui_video', 'video', 'comfyui'],
    ] as const) {
      const row = byKey.get(key)
      check(!!row && row.serviceType === st && row.vendor === vendor, `${key} 目录行已 seed（${st} / ${vendor}）`)
    }
    // —— kit 注册表 ⊇ 宿主本地轨目录（派发命中 + provider 串对齐）——
    check(kit.getImageAdapter('localai_image').provider === 'localai_image', 'kit image 注册表含 localai_image')
    check(kit.getImageAdapter('comfyui_image').provider === 'comfyui_image', 'kit image 注册表含 comfyui_image')
    check(kit.getImageAdapter('localai_image').referenceImages === 'base64', 'localai_image 声明参考图 base64（ref_images 通道）')
    check(kit.getVideoAdapter('localai_video').provider === 'localai_video', 'kit video 注册表含 localai_video')
    check(kit.getVideoAdapter('comfyui_video').provider === 'comfyui_video', 'kit video 注册表含 comfyui_video')
    check(kit.getVideoAdapter('localai_video').firstFrame === 'base64', 'localai_video 声明首帧 base64（start_image）')
    check(kit.listVideoAdapterKeys().includes('localai_video') && kit.listVideoAdapterKeys().includes('comfyui_video'), 'listVideoAdapterKeys 覆盖本地轨视频')
    check(kit.getMusicAdapter('localai_music').provider === 'localai', 'kit music 注册表含 localai_music（provider=localai）')
    // 未注册 key 报错口径不变
    let notReady = ''
    try { kit.getVideoAdapter('localai_nonexistent') } catch (e) { notReady = (e as Error).name }
    check(notReady === 'VideoProviderNotReadyError', '未注册视频 key 仍走 VideoProviderNotReadyError')
    // —— video-caps 背书档位 ——
    const laCaps = kit.resolveVideoCaps('localai_video', 'any-model')
    check(!!laCaps && laCaps.modes.includes('i2v') && laCaps.modes.includes('t2v') && laCaps.resolutions.includes('480p'), 'localai_video 保守背书档（i2v/t2v + 480p）')
    check(kit.resolveVideoCaps('comfyui_video', 'any') === null, 'comfyui_video 不自动背书（工作流自定义，fail-closed null）')
  },

  runners: {
    pure: async () => {
    // —— LocalAI 图像契约 ——
    const imgTxt = kit.buildLocalAIImageBody({ prompt: 'a cat', size: '512x512', baseUrl: 'http://localhost:8080', apiKey: '' })
    check(imgTxt.response_format === 'b64_json' && imgTxt.prompt === 'a cat' && imgTxt.size === '512x512', 'buildLocalAIImageBody：txt2img 强制 b64_json + size 透传')
    check(imgTxt.ref_images === undefined, 'buildLocalAIImageBody：无参考图不下发 ref_images')
    const imgRef = kit.buildLocalAIImageBody({ prompt: 'x', referenceImages: ['data:image/png;base64,AAA'], baseUrl: 'b', apiKey: '' })
    check(Array.isArray(imgRef.ref_images) && imgRef.ref_images![0] === 'data:image/png;base64,AAA', 'buildLocalAIImageBody：参考图透传进 ref_images（非 multipart edits）')
    const parsedB64 = kit.parseLocalAIImageResponse({ data: [{ b64_json: PNG_B64 }] })
    check(parsedB64.kind === 'base64' && parsedB64.mime === 'image/png', 'parseLocalAIImageResponse：b64_json → base64 + PNG 魔数嗅探')
    const parsedUrl = kit.parseLocalAIImageResponse({ data: [{ url: 'http://h/generated-images/x.png' }] })
    check(parsedUrl.kind === 'url', 'parseLocalAIImageResponse：url 形态回落')
    let imgErr = false
    try { kit.parseLocalAIImageResponse({ data: [] }) } catch { imgErr = true }
    check(imgErr, 'parseLocalAIImageResponse：空 data[] 抛错')

    // —— LocalAI 视频契约 ——
    check(kit.localAIVideoRootUrl('http://localhost:8080/v1') === 'http://localhost:8080', 'localAIVideoRootUrl：剥 /v1 尾缀（/video 在根路径）')
    check(kit.localAIVideoModelsUrl('http://localhost:8080') === 'http://localhost:8080/v1/models', 'localAIVideoModelsUrl：根域 + /v1/models')
    const vid = kit.buildLocalAIVideoBody({ prompt: 'run', duration: 4, resolution: '832x480', firstFrameUrl: 'data:image/png;base64,AAA', baseUrl: 'http://localhost:8080/v1', apiKey: '', extra: { fps: 8, seed: 42 } })
    check(vid.response_format === 'b64_json' && vid.seconds === 4 && vid.start_image === 'data:image/png;base64,AAA', 'buildLocalAIVideoBody：b64_json + duration→seconds + 首帧 start_image')
    check(vid.fps === 8 && vid.num_frames === 32 && vid.width === 832 && vid.height === 480 && vid.seed === 42, 'buildLocalAIVideoBody：fps→num_frames(时长×fps) + WxH + seed')
    const parsedVid = kit.parseLocalAIVideoResponse({ data: [{ b64_json: 'AAAA' }] })
    check(parsedVid.kind === 'base64' && parsedVid.mime === 'video/mp4', 'parseLocalAIVideoResponse：data[0].b64_json → base64')

    // —— ComfyUI 工作流契约 ——
    const wf = kit.buildComfyUIWorkflow(
      '{"3":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}},"9":{"class_type":"KSampler","inputs":{"seed":"{{seed}}","width":{{width}},"height":{{height}}}}}',
      { prompt: 'hello "world"', seed: 7, width: 512, height: 288 },
    )
    check((wf['3'] as { inputs: { text: string } }).inputs.text === 'hello "world"', 'buildComfyUIWorkflow：{{prompt}} 注入含引号文本正确转义')
    check((wf['9'] as { inputs: Record<string, unknown> }).inputs.seed === 7, 'buildComfyUIWorkflow：{{seed}} 带引号占位替换为数字')
    check((wf['9'] as { inputs: Record<string, unknown> }).inputs.width === 512 && (wf['9'] as { inputs: Record<string, unknown> }).inputs.height === 288, 'buildComfyUIWorkflow：{{width}}/{{height}} 裸占位替换为数字')
    let wfErr = false
    try { kit.buildComfyUIWorkflow('', { prompt: 'x' }) } catch { wfErr = true }
    check(wfErr, 'buildComfyUIWorkflow：空 workflow_json fail-closed 抛错')

    const history = { p1: { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }
    check(kit.extractComfyUIOutputFiles(history, 'p1', 'image')[0]?.filename === 'a.png', 'extractComfyUIOutputFiles：image 取 images[]')
    const vHist = { p2: { outputs: { '12': { images: [{ filename: 'preview.png', type: 'output' }] }, '13': { video: [{ filename: 'v.mp4', type: 'output' }] } } } }
    check(kit.extractComfyUIOutputFiles(vHist, 'p2', 'video')[0]?.filename === 'v.mp4', 'extractComfyUIOutputFiles：video 优先 video[]')
    const vFall = { p3: { outputs: { '14': { images: [{ filename: 'out.webp', type: 'output' }] } } } }
    check(kit.extractComfyUIOutputFiles(vFall, 'p3', 'video')[0]?.filename === 'out.webp', 'extractComfyUIOutputFiles：video 无专门键回落 images[]')
    check(kit.extractComfyUIOutputFiles({}, 'px', 'image').length === 0, 'extractComfyUIOutputFiles：无产物 → 空数组')
    let injErr = false
    try { kit.injectComfyUIInputNode({ '5': { inputs: {} } }, '999', 'image', 'x.png') } catch { injErr = true }
    check(injErr, 'injectComfyUIInputNode：目标节点缺失 fail-closed 抛错')

    // —— LocalAI 音乐契约 ——
    check(kit.localAIMusicUrl('http://localhost:8080') === 'http://localhost:8080/v1/sound-generation', 'localAIMusicUrl：补 /v1 + /sound-generation')
    const mBody = kit.buildLocalAIMusicBody({ providerKey: 'localai_music', baseUrl: 'b', apiKey: '', model: 'ace-step-turbo', extra: {} }, { prompt: 'calm jazz', instrumental: true, audioSetting: { duration_seconds: 10 } })
    check(mBody.model_id === 'ace-step-turbo' && mBody.text === 'calm jazz' && mBody.instrumental === true && mBody.duration_seconds === 10, 'buildLocalAIMusicBody：model_id/text/instrumental/duration_seconds')
  },

    live: async () => {
      const fetchBak = globalThis.fetch
      try {
        // —— LocalAI 图像：POST /v1/images/generations，空 Key 不带 Authorization ——
        const imgSeen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const headers = (init?.headers ?? {}) as Record<string, string>
          imgSeen.push({ url, auth: headers.Authorization ?? null, body: JSON.parse(String(init?.body ?? '{}')) })
          return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }) as typeof fetch
        const imgOut = await kit.getImageAdapter('localai_image').generate({ prompt: 'cat', size: '256x256', model: 'flux', baseUrl: 'http://localhost:8080', apiKey: '', extra: {} })
        check(imgSeen[0]?.url === 'http://localhost:8080/v1/images/generations', 'live localai_image：端点 /v1/images/generations')
        check(imgSeen[0]?.auth === null && imgSeen[0]?.body.response_format === 'b64_json' && imgSeen[0]?.body.model === 'flux', 'live localai_image：空 Key 无鉴权头 + b64_json + model')
        check(imgOut.kind === 'base64' && imgOut.mime === 'image/png', 'live localai_image：b64 直收出图')

      // —— LocalAI 视频：POST /video（根路径），probe GET /v1/models ——
      let vidUrl = ''
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        vidUrl = url
        if (url.endsWith('/video')) return new Response(JSON.stringify({ created: 1, id: 'v1', data: [{ b64_json: 'AAAA' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        throw new Error(`m55 桩未预期端点：${url}`)
      }) as typeof fetch
      const vidOut = await kit.getVideoAdapter('localai_video').generate({ prompt: 'run', duration: 4, baseUrl: 'http://localhost:8080/v1', apiKey: '', extra: { fps: 8 } })
      check(vidUrl === 'http://localhost:8080/video', 'live localai_video：/v1 baseUrl → 根路径 /video')
      check(vidOut.kind === 'base64' && vidOut.mime === 'video/mp4', 'live localai_video：data[0].b64_json 直收')
      const vProbe = await kit.getVideoAdapter('localai_video').probe!({ baseUrl: 'http://localhost:8080', apiKey: '' })
      check(typeof vProbe === 'string' && vProbe.includes('2 个模型'), 'live localai_video.probe：GET /v1/models 报告模型数（零成本）')

      // —— ComfyUI 图像：/prompt → /history → /view 三段链路 ——
      const cfSeen: string[] = []
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        cfSeen.push(`${(init?.method ?? 'GET')} ${url}`)
        if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.includes('/history/p1')) return new Response(JSON.stringify({ p1: { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.includes('/view')) return new Response(PNG_B64 ? Buffer.from(PNG_B64, 'base64') : new Uint8Array(), { status: 200, headers: { 'Content-Type': 'image/png' } })
        throw new Error(`m55 桩未预期端点：${url}`)
      }) as typeof fetch
      const cfImg = await kit.getImageAdapter('comfyui_image').generate({ prompt: 'cat', model: 'sd', baseUrl: 'http://localhost:8188', apiKey: '', extra: { workflow_json: '{"9":{"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"out"}},"3":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}' } })
      check(cfSeen[0] === 'POST http://localhost:8188/prompt', 'live comfyui_image：首跳 POST /prompt')
      check(cfSeen.some((s) => s.startsWith('GET') && s.includes('/history/p1')) && cfSeen.some((s) => s.includes('/view')), 'live comfyui_image：/history 轮询 + /view 取产物')
      check(cfImg.kind === 'base64' && cfImg.mime === 'image/png', 'live comfyui_image：产物转 base64')

      // —— ComfyUI probe：GET /system_stats ——
      let statsUrl = ''
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        statsUrl = String(input)
        return new Response(JSON.stringify({ system: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      await kit.getVideoAdapter('comfyui_video').probe!({ baseUrl: 'http://localhost:8188', apiKey: '' })
      check(statsUrl === 'http://localhost:8188/system_stats', 'live comfyui probe：GET /system_stats 零成本')

      // —— LocalAI 音乐：POST /v1/sound-generation → 二进制直收 ——
      let musUrl = ''
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        musUrl = String(input)
        void init
        return new Response(WAV_BYTES as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
      }) as typeof fetch
      const mus = await kit.getMusicAdapter('localai_music').generate(
        { providerKey: 'localai_music', baseUrl: 'http://localhost:8080', apiKey: '', model: 'ace-step-turbo', extra: {} },
        { prompt: 'calm jazz', instrumental: true },
      )
      check(musUrl === 'http://localhost:8080/v1/sound-generation', 'live localai_music：POST /v1/sound-generation')
      check(mus.audio.byteLength === WAV_BYTES.length && mus.model === 'ace-step-turbo', 'live localai_music：二进制直收 + model 口径')
    } finally {
      globalThis.fetch = fetchBak
    }
        void MP4_BYTES
      },
  },
})
