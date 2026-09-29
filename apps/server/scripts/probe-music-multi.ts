/**
 * 音乐多供应商适配探针（kit music 注册表：MiniMax/百炼 Fun-Music/火山 GenBGM/Pollinations /audio）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-music-multi.ts [--section=pure|live]
 *
 * 隔离策略：isolatedEnv('musicx') 一次性临时目录（独立 studio.db），registry 节断言 seed 目录行；
 * live 节 globalThis.fetch 桩做全链路契约测试（零真实付费）：百炼同步直返 URL+下载、
 * 火山 提交→轮询(1→2)→音频下载 状态机、Pollinations GET /audio/{text} 直返字节+401/402 语义、
 * 签名头形态、派发与未注册 key 报错口径。
 *
 * 断言面（官方 schema 核实 2026：help.aliyun.com fun-music-api / docs.volcengine.com 音视频理解+签名调用指南 / gen.pollinations.ai openapi getAudioByText）：
 *  - pure：buildAliyunMusicBody/parseAliyunMusicResponse/aliyunMusicError 契约；
 *    parseVolcCredentials 双形态、volcDates/volcCanonicalQuery 规范化、signVolcRequest 确定性与格式、
 *    buildVolcMusicBody 两族形态、parseVolcSubmit/QueryResponse 状态机（Status 2 才是成功）；
 *    pollinationsMusicFamily/Text/Params/Url 家族参数面与 401/402 错误归一；
 *  - live：generateAliyunMusic URL 拼接（/api/v1 去重 + compatible-mode 互斥）+ Bearer + 官方样例响应 + 下载字节；
 *    generateVolcMusic 全链路（Action 式 + Authorization 头 + 轮询节奏 + 失败态抛错）；
 *    generatePollinationsMusic GET /audio 字节直收 + 查询串出线 + 402 透出；getMusicAdapter 派发。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('musicx')

const SECTIONS = ['pure', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-music-multi')
const checker: Checker = makeChecker(log)
const check = checker.check

const kit = await import('@agencys/ai-provider-kit')

await runSections({
  log,
  title: 'MUSIC-MULTI',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    const { db } = await import('../src/db')
    const { apiProviders } = await import('../src/db/schema')
    const rows = await db.select().from(apiProviders)
    const music = rows.filter((r) => r.serviceType === 'music').map((r) => r.key).sort()
    // minimax_music 已退役不再预种（MiniMax 付费音乐接口 2026-08-20 起不再面向新用户，新用户无从开通）
    check(
      JSON.stringify(music) === JSON.stringify(['aliyun_bailian_music', 'volcengine_music']),
      `两供应商音乐目录行已 seed（实际 ${JSON.stringify(music)}）`,
    )
    // kit 注册表 ⊇ 宿主目录：网关私有协议行（pollinations_music）与退役款（minimax_music）已不再 seed，kit 侧适配器保留供存量实例派发，不影响宿主
    check(kit.listMusicAdapterKeys().every((k) => music.includes(k) || k === 'pollinations_music' || k === 'minimax_music') && music.every((k) => kit.listMusicAdapterKeys().includes(k)), 'kit 音乐注册表覆盖宿主目录行（网关款/退役款仅存 kit 层）')
  },
  runners: {
    // ================= pure：契约纯函数（零 HTTP） =================
    pure: async () => {
      // —— 百炼 Fun-Music ——
      const b1 = kit.buildAliyunMusicBody('', { prompt: '钢琴纯音乐' })
      check(b1.model === 'fun-music-v1' && (b1.input as Record<string, unknown>).is_instrumental === true && (b1.input as Record<string, unknown>).prompt === '钢琴纯音乐' && (b1.input as Record<string, unknown>).format === 'mp3', '百炼默认体：fun-music-v1 + 纯音乐 prompt + mp3')
      const b2 = kit.buildAliyunMusicBody('fun-music-preview', { prompt: 'p', lyrics: '歌词正文', instrumental: false }, { gender: 'MALE' })
      const i2 = b2.input as Record<string, unknown>
      check(b2.model === 'fun-music-preview' && i2.lyrics === '歌词正文' && i2.prompt === undefined && i2.gender === 'male' && i2.is_instrumental === undefined, '百炼歌曲体：lyrics 优先于 prompt + gender 归一小写')
      const okDoc = { output: { audio: { data: '', url: 'http://oss.example/a.mp3' }, extra_info: { sample_rate: 48000 }, finish_reason: 'stop' }, usage: { duration: 200 }, request_id: 'r-1' }
      const p1 = kit.parseAliyunMusicResponse(okDoc)
      check(p1?.audioUrl === 'http://oss.example/a.mp3' && p1?.durationMs === 200000, '百炼官方样例响应归一：url + duration(秒)→ms')
      check(kit.parseAliyunMusicResponse({ output: { audio: { data: '', url: '' } } }) === null, '百炼 url 空串视为缺失')
      check(kit.parseAliyunMusicResponse(null) === null, '百炼空响应 → null')
      check(kit.aliyunMusicError({ code: 'AccessDenied', message: 'model not open', request_id: 'r2' }, 'fb') === '[AccessDenied] model not open (request_id: r2)', '百炼错误归一：[code] message (request_id)')

      // —— 火山音乐凭证/日期/查询串 ——
      check(JSON.stringify(kit.parseVolcCredentials('AKID123/SECRET456')) === JSON.stringify({ accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' }), '火山凭证：AK/SK 拼接')
      check(JSON.stringify(kit.parseVolcCredentials('AKID123:SECRET456')) === JSON.stringify({ accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' }), '火山凭证：AK:SK 拼接')
      const fromExtra = kit.parseVolcCredentials('junk', { access_key_id: 'AKX', access_key_secret: 'SKX' })
      check(fromExtra.accessKeyId === 'AKX' && fromExtra.secretAccessKey === 'SKX', '火山凭证：extra 优先于 apiKey')
      check(kit.parseVolcCredentials('single-key').accessKeyId === '', '火山凭证：非法形态 → 空（generate 层报错）')
      const dates = kit.volcDates(new Date('2026-09-01T08:00:00Z'))
      check(dates.xDate === '20260901T080000Z' && dates.shortDate === '20260901', '火山时间对：X-Date/ShortDate UTC 形态')
      check(kit.volcCanonicalQuery({ Version: '2024-08-12', Action: 'GenBGMForTime' }) === 'Action=GenBGMForTime&Version=2024-08-12', '火山规范查询串：ASCII 升序')
      check(kit.volcCanonicalQuery({ q: 'a b~c(d)' }) === 'q=a%20b~c%28d%29', '火山 RFC3986 编码：空格 %20、~ 不编码、括号转义')

      // —— 火山签名（确定性 + 格式，与官方 Authorization 模板对齐） ——
      const cred = { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' }
      const req = { method: 'POST', path: '/', query: { Action: 'GenBGMForTime', Version: '2024-08-12' }, body: '{"Text":"x"}', host: 'open.volcengineapi.com' }
      const s1 = kit.signVolcRequest(cred, req, new Date('2026-09-01T08:00:00Z'))
      const s2 = kit.signVolcRequest(cred, req, new Date('2026-09-01T08:00:00Z'))
      check(s1.authorization === s2.authorization, '火山签名确定性：同输入同 now → 同签名')
      check(/^HMAC-SHA256 Credential=AKID123\/20260901\/cn-beijing\/imagination\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/.test(s1.authorization), '火山 Authorization 头形态：Credential/SignedHeaders/Signature 官方模板')
      const sAlt = kit.signVolcRequest(cred, { ...req, body: '{"Text":"y"}' }, new Date('2026-09-01T08:00:00Z'))
      check(/^[0-9a-f]{64}$/.test(s1.contentSha256) && s1.contentSha256 !== sAlt.contentSha256, '火山 payload 哈希 64-hex 形态且对 Body 敏感')
      const sDiff = kit.signVolcRequest({ ...cred, secretAccessKey: 'OTHER' }, req, new Date('2026-09-01T08:00:00Z'))
      check(sDiff.authorization !== s1.authorization, '火山签名对 SK 敏感（篡改即不同）')

      // —— 火山请求体与状态机 ——
      const v1 = kit.buildVolcMusicBody('', { prompt: '咖啡馆背景音乐' })
      check(v1.action === 'GenBGM' && v1.body.Text === '咖啡馆背景音乐' && v1.body.Version === 'v5.0', '火山纯音乐体：GenBGM 族 + Text + 默认 v5.0')
      const v2 = kit.buildVolcMusicBody('v4.3', { prompt: 'p', lyrics: '歌词', instrumental: false })
      check(v2.action === 'GenSong' && v2.body.Lyrics === '歌词' && v2.body.ModelVersion === 'v4.3' && v2.body.VodFormat === 'mp3', '火山歌曲体：GenSong 族 lyrics 形态 + ModelVersion 透传')
      const v3 = kit.buildVolcMusicBody('', { prompt: 'p' }, { duration_seconds: 60.4 })
      check(v3.body.Duration === 60, '火山时长取整下发（60.4→60）')
      const v4 = kit.buildVolcMusicBody('', { prompt: 'p' }, { duration_seconds: 200 })
      check(v4.body.Duration === undefined, '火山越界时长不下发（>120 交官方默认）')
      const sub = kit.parseVolcSubmitResponse({ Code: 0, Message: 'success', Result: { TaskID: 'T-1' } })
      check(sub.taskId === 'T-1' && sub.error === null, '火山提交归一：Code=0 + TaskID')
      check(kit.parseVolcSubmitResponse({ Code: 50000001, Message: 'copyright' }).error?.includes('50000001') === true, '火山提交非零 Code → 错误带码')
      check(kit.parseVolcQueryResponse({ Code: 0, Result: { Status: 0 } }).state === 'pending' && kit.parseVolcQueryResponse({ Code: 0, Result: { Status: 1 } }).state === 'pending', '火山任务 0/1 → 进行中')
      const done = kit.parseVolcQueryResponse({ Code: 0, Result: { Status: 2, SongDetail: { AudioUrl: 'https://v1-default.douyinvod.com/a.mp3', Duration: 46.002 } } })
      check(done.state === 'done' && done.durationMs === 46002, '火山任务 2=成功：AudioUrl + Duration(秒)→ms')
      const fail = kit.parseVolcQueryResponse({ Code: 0, Result: { Status: 3, FailureReason: { Code: 300061, Msg: 'InputLyricsPlagiarized' } } })
      check(fail.state === 'failed' && fail.error?.includes('[300061]') === true, '火山任务 3=失败：FailureReason 带码文案（2 才是成功的枚举红线）')

      // —— Pollinations 音乐（/audio/{text} 家族参数面） ——
      check(kit.pollinationsMusicFamily('elevenlabs/music-v2.5') === 'elevenmusic' && kit.pollinationsMusicFamily('google/lyria-3.5') === 'lyria' && kit.pollinationsMusicFamily('stability-ai/stable-audio-3-medium') === 'stableaudio' && kit.pollinationsMusicFamily('') === 'elevenmusic', 'Pollinations 家族判型：elevenmusic/lyria/stableaudio + 缺省归 ElevenLabs 面')
      const pp1 = kit.buildPollinationsMusicParams('', { prompt: 'p' }, { duration_seconds: 45 })
      check(pp1.model === 'elevenlabs/music-v2' && pp1.instrumental === 'true' && pp1.duration === '45', 'Pollinations 默认体：elevenlabs/music-v2 + instrumental + duration(3-300)')
      const pp2 = kit.buildPollinationsMusicParams('elevenlabs/music-v2', { prompt: 'p', instrumental: false, lyrics: '歌词' }, { duration_seconds: 2 })
      check(pp2.instrumental === undefined && pp2.duration === undefined, 'Pollinations 越界/歌曲形态：duration<3 不下发、instrumental 不强制')
      const pp3 = kit.buildPollinationsMusicParams('stability-ai/stable-audio-3', { prompt: 'p' }, { duration_seconds: 300, steps: 8, seed: 42, negative_prompt: 'vocals' })
      check(pp3.seconds === '300' && pp3.steps === '8' && pp3.seed === '42' && pp3.negative_prompt === 'vocals' && pp3.duration === undefined, 'Pollinations Stable Audio 面：seconds/steps/seed/negative_prompt，不发 duration')
      const pp4 = kit.buildPollinationsMusicParams('google/lyria-3.5', { prompt: 'p' }, { duration_seconds: 60 })
      check(pp4.duration === undefined && pp4.seconds === undefined, 'Pollinations Lyria 不接受时长参数（写进 prompt 文本）')
      check(kit.pollinationsMusicText('google/lyria-3.5', { prompt: '爵士' }, { duration_seconds: 60.4 }).includes('approximately 60 seconds') === true, 'Pollinations Lyria 约时长写入 prompt（取整）')
      check(kit.pollinationsMusicText('elevenlabs/music-v2', { prompt: 'p', instrumental: false, lyrics: '歌词正文' }) === '歌词正文', 'Pollinations 歌曲形态 lyrics 优先')
      const pu = kit.buildPollinationsMusicUrl('https://gen.pollinations.ai/v1', '钢琴 纯音乐', '', { prompt: '钢琴 纯音乐' })
      check(pu === 'https://gen.pollinations.ai/audio/%E9%92%A2%E7%90%B4%20%E7%BA%AF%E9%9F%B3%E4%B9%90?model=elevenlabs%2Fmusic-v2&instrumental=true', 'Pollinations URL 契约：/v1 剥根域 + text 路径编码 + model/instrumental 出线')
      check(kit.pollinationsMusicError(401, '{"error":{"code":"UNAUTHORIZED","message":"bad key"}}') === 'HTTP 401: [UNAUTHORIZED] bad key（API Key 无效，Pollinations 须 sk_ 开头 Bearer 密钥）', 'Pollinations 401 归一：密钥语义提示')
      check(kit.pollinationsMusicError(402, 'not json').includes('Pollen 余额不足，链路已通') === true, 'Pollinations 402 归一：余额不足与链路已通的区分口径')

      // —— 注册表派发 ——
      check(kit.getMusicAdapter('minimax_music').provider === 'minimax' && kit.getMusicAdapter('aliyun_bailian_music').provider === 'aliyun' && kit.getMusicAdapter('volcengine_music').provider === 'volcengine' && kit.getMusicAdapter('pollinations_music').provider === 'pollinations', 'getMusicAdapter 四供应商派发')
      let notReady = ''
      try { kit.getMusicAdapter('silkflow_music') } catch (e) { notReady = (e as Error).message }
      check(notReady.includes('未注册') && notReady.includes('minimax_music'), '未注册 key → MusicProviderNotReadyError（列可选项）')
    },

    // ================= live：fetch 桩全链路（零真实付费） =================
    live: async () => {
      const fetchBak = globalThis.fetch
      const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x00, 0x01, 0x02])
      try {
        // —— 百炼：同步直返 URL + 二次下载 ——
        const aliCalls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = []
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('dashscope.aliyuncs.com/api/v1/services/audio/music/generation')) {
            aliCalls.push({ url, auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''), body: JSON.parse(String(init?.body ?? '{}')) })
            return new Response(JSON.stringify({ output: { audio: { data: '', url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x/a.mp3' }, finish_reason: 'stop' }, usage: { duration: 12 }, request_id: 'r-9' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          if (url.includes('oss-cn-beijing')) return new Response(mp3Bytes as unknown as BodyInit, { status: 200 })
          throw new Error(`music 桩仅放行白名单端点：${url}`)
        }) as typeof fetch
        const aliEp = { providerKey: 'aliyun_bailian_music', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'sk-probe', model: 'fun-music-v1', extra: {} }
        const ali = await kit.generateAliyunMusic(aliEp, { prompt: '钢琴纯音乐，安静' })
        check(ali.audio.length === mp3Bytes.length && ali.durationMs === 12000 && ali.model === 'fun-music-v1', '百炼全链路：请求→URL→下载字节 + duration 口径')
        const ac = aliCalls[0]
        check(!!ac && ac.url === 'https://dashscope.aliyuncs.com/api/v1/services/audio/music/generation' && ac.auth === 'Bearer sk-probe', '百炼端点契约：/api/v1 去重拼接 + Bearer')
        check(ac!.body.model === 'fun-music-v1' && (ac!.body.input as Record<string, unknown>).is_instrumental === true, '百炼请求体契约：model + input.is_instrumental')
        // compatible-mode 形态 baseUrl 互斥改写（已知缺陷同源路径）
        aliCalls.length = 0
        await kit.generateAliyunMusic({ ...aliEp, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, { prompt: 'x' })
        check(aliCalls[0]?.url === 'https://dashscope.aliyuncs.com/api/v1/services/audio/music/generation', '百炼 compatible-mode baseUrl → 改写原生 /api/v1 路径')
        // 邀测未开通错误形态透出
        globalThis.fetch = (async () => new Response(JSON.stringify({ code: 'AccessDenied', message: 'fun-music not activated', request_id: 'r-e' }), { status: 400 })) as typeof fetch
        let aliErr = ''
        try { await kit.generateAliyunMusic(aliEp, { prompt: 'x' }) } catch (e) { aliErr = (e as Error).message }
        check(aliErr.includes('[AccessDenied]') && aliErr.includes('not activated'), '百炼邀测未开通：HTTP 400 + code/message 透出（由调用方降级）')

        // —— 火山：提交 → 轮询(0/1→2) → 下载，全 Action 式签名链路 ——
        const volcSeen: Array<{ action: string; auth: string; body: Record<string, unknown> }> = []
        let queryRound = 0
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('open.volcengineapi.com')) {
            const action = new URL(url).searchParams.get('Action') ?? ''
            const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
            const headers = (init?.headers ?? {}) as Record<string, string>
            volcSeen.push({ action, auth: String(headers.Authorization ?? ''), body })
            if (action === 'GenBGMForTime') return new Response(JSON.stringify({ Code: 0, Message: 'success', Result: { TaskID: 'T-777', PredictedWaitTime: 2 } }), { status: 200 })
            if (action === 'QuerySong') {
              queryRound += 1
              if (queryRound < 2) return new Response(JSON.stringify({ Code: 0, Result: { Status: 1, Progress: 40 } }), { status: 200 })
              return new Response(JSON.stringify({ Code: 0, Result: { Status: 2, SongDetail: { AudioUrl: 'https://v9-default.douyinvod.com/a.mp3', Duration: 45.5 } } }), { status: 200 })
            }
          }
          if (url.includes('douyinvod')) return new Response(mp3Bytes as unknown as BodyInit, { status: 200 })
          throw new Error(`music 桩仅放行白名单端点：${url}`)
        }) as typeof fetch
        const volcEp = { providerKey: 'volcengine_music', baseUrl: 'https://open.volcengineapi.com', apiKey: 'AKID123/SECRET456', model: '', extra: {} }
        const volc = await kit.generateVolcMusic(volcEp, { prompt: '关于星空的背景纯音乐', timeoutMs: 60_000 })
        check(volc.audio.length === mp3Bytes.length && volc.durationMs === 45500 && volc.model === 'v5.0', '火山全链路：提交→轮询→下载字节 + Duration 口径 + 默认版本 v5.0')
        const submit = volcSeen.find((c) => c.action === 'GenBGMForTime')
        const queries = volcSeen.filter((c) => c.action === 'QuerySong')
        check(!!submit && (submit.body.Text as string).includes('星空') && submit.body.Version === 'v5.0', '火山提交契约：后付费 GenBGMForTime + Text/Version')
        check(/^HMAC-SHA256 Credential=AKID123\/\d{8}\/cn-beijing\/imagination\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/.test(submit?.auth ?? ''), '火山签名头真实出线：官方 Authorization 模板')
        check(queries.length >= 2 && queries[0]!.body.TaskID === 'T-777', '火山轮询契约：QuerySong + TaskID 透传（Status=1 继续等）')
        // 任务失败态 → 抛错带 FailureReason
        globalThis.fetch = (async (input: string | URL | Request) => {
          const url = String(input)
          if (url.includes('GenBGMForTime')) return new Response(JSON.stringify({ Code: 0, Result: { TaskID: 'T-8' } }), { status: 200 })
          return new Response(JSON.stringify({ Code: 0, Result: { Status: 3, FailureReason: { Code: 50000001, Msg: 'CopyrightCheckFailed' } } }), { status: 200 })
        }) as typeof fetch
        let volcErr = ''
        try { await kit.generateVolcMusic(volcEp, { prompt: '短音乐易触发版权校验', timeoutMs: 30_000 }) } catch (e) { volcErr = (e as Error).message }
        check(volcErr.includes('[50000001]') && volcErr.includes('CopyrightCheckFailed'), '火山失败态抛错：FailureReason 码/文案透出（由调用方降级）')

        // —— Pollinations：GET /audio/{text} 同步直返字节（无二次下载） ——
        const polSeen: Array<{ url: string; auth: string }> = []
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('gen.pollinations.ai/audio/')) {
            polSeen.push({ url, auth: String(((init?.headers ?? {}) as Record<string, string>).Authorization ?? '') })
            return new Response(mp3Bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
          }
          throw new Error(`music 桩仅放行白名单端点：${url}`)
        }) as typeof fetch
        const polEp = { providerKey: 'pollinations_music', baseUrl: 'https://gen.pollinations.ai/v1', apiKey: 'sk-probe', model: 'elevenlabs/music-v2', extra: { duration_seconds: 30 } }
        const pol = await kit.generatePollinationsMusic(polEp, { prompt: '轻快钢琴 BGM', instrumental: true })
        check(pol.audio.length === mp3Bytes.length && pol.durationMs === null && pol.model === 'elevenlabs/music-v2', 'Pollinations 全链路：字节直收 + durationMs=null 交宿主 ffprobe 回读')
        const polUrl = new URL(polSeen[0]!.url)
        check(polSeen[0]!.auth === 'Bearer sk-probe' && polUrl.pathname === '/audio/' + encodeURIComponent('轻快钢琴 BGM') && !polUrl.pathname.startsWith('/v1'), 'Pollinations 端点契约：根域 /audio/{text} 路径段 + Bearer')
        check(polUrl.searchParams.get('model') === 'elevenlabs/music-v2' && polUrl.searchParams.get('duration') === '30' && polUrl.searchParams.get('instrumental') === 'true', 'Pollinations 查询串出线：model/duration/instrumental')
        globalThis.fetch = (async () => new Response('{"status":402,"success":false,"error":{"code":"PAYMENT_REQUIRED","message":"Insufficient balance"}}', { status: 402 })) as typeof fetch
        let polErr = ''
        try { await kit.generatePollinationsMusic(polEp, { prompt: 'x' }) } catch (e) { polErr = (e as Error).message }
        check(polErr.includes('[PAYMENT_REQUIRED]') && polErr.includes('余额不足'), 'Pollinations 402 透出：Pollen 余额不足（密钥有效）由调用方降级')

        // —— 派发一致性：宿主 music-gen 走注册表 ——
        const { getMusicAdapter } = kit
        check(typeof getMusicAdapter('volcengine_music').generate === 'function' && typeof getMusicAdapter('pollinations_music').generate === 'function', 'music-gen 派发面：generate 函数可达')
      } finally {
        globalThis.fetch = fetchBak
      }
    },
  },
})
