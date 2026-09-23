/** M19[voice-clone]：voice_clones 表模型 + 能力位矩阵 + parseCloneRef/validCloneRef + sanitizeClonePrefix + normalizeSampleMime/validateCloneSample + buildEnrollBody/parseEnrollResponse 协议快照 + createVoiceClone 全链/校验族/供应商错误族 + resolveVoiceChain/cloneEndpoint/synthWithClone + tts 真步集成 + deleteVoiceClone 降级（断言体逐字搬自原 probe-m19.ts） */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceClone } from '../../../src/db/schema'
import type { M19Ctx } from './ctx'

export async function run(ctx: M19Ctx): Promise<void> {
  const { check, db, T0, errOf, mkProject, eq, voiceClones, pipelineRuns } = ctx
  {
    await db.insert(voiceClones).values({
      name: '探针音色',
      providerKey: 'aliyun_bailian_tts',
      model: 'cosyvoice-v1',
      voiceId: 'voice-probe-1',
      status: 'ready',
      meta: JSON.stringify({ protocol: 'dashscope-enrollment', prefix: 'probe' }),
      createdAt: T0,
      updatedAt: T0,
    })
    const rows = await db.select().from(voiceClones).where(eq(voiceClones.name, '探针音色')).limit(1)
    check(rows[0]?.voiceId === 'voice-probe-1' && rows[0]?.status === 'ready', 'voice_clones 插入/读取往返')
    const dupErr = await errOf(async () =>
      db.insert(voiceClones).values({ name: '探针音色', providerKey: 'x', model: 'y', voiceId: 'z', createdAt: T0, updatedAt: T0 }),
    )
    check(dupErr instanceof Error, 'voice_clones.name 唯一约束生效（重名不允许）')

    // ---- [P8] 能力位矩阵（VOICE_CLONE_PROVIDERS = 唯一事实源；未登记 = 不支持） ----
    await db.delete(voiceClones) // 清掉 P1 样板行，后续节在受控空库上跑
    const tc = await import('../../../src/services/tts-clone')
    const {
      CLONE_SAMPLE_MAX_BYTES,
      CLONE_TEST_MAX_CHARS,
      VOICE_CLONE_PROVIDERS,
      VOICE_CLONE_PROTOCOLS,
      buildEnrollBody,
      cloneCapabilityOf,
      cloneEndpoint,
      createVoiceClone,
      deleteVoiceClone,
      getVoiceClone,
      listCloneProviders,
      listVoiceClones,
      loadCloneIndex,
      normalizeSampleMime,
      parseCloneRef,
      parseEnrollResponse,
      sanitizeClonePrefix,
      synthWithClone,
      validCloneRef,
      validateCloneSample,
    } = tc
    const { resolveVoiceChain } = await import('../../../src/pipeline/actions/tts')
    const { apiConfigs, assets, pipelineSteps, usageRecords } = await import('../../../src/db/schema')
    const { upsertEntity } = await import('../../../src/services/character')
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    check(cloneCapabilityOf('aliyun_bailian_tts') === true, '能力位：aliyun_bailian_tts 已登记克隆协议')
    check(
      cloneCapabilityOf('siliconflow_audio') === false && cloneCapabilityOf('openai_audio') === false && cloneCapabilityOf('volcengine_audio') === false,
      '能力位：未登记供应商 = 不支持（UI 下拉置灰依据；v1 不伪接未验证协议）',
    )
    check(
      Object.values(VOICE_CLONE_PROVIDERS).every((p) => p.protocol in VOICE_CLONE_PROTOCOLS && !!p.defaultTargetModel),
      '能力位表自洽：协议均在协议族登记 + 均携默认目标模型',
    )
    const provs = await listCloneProviders()
    check(provs.some((p) => p.key === 'aliyun_bailian_tts' && p.available === true), 'listCloneProviders：audio 目录内 aliyun 标记 available')
    check(
      provs.length > 0 && provs.every((p) => p.available === cloneCapabilityOf(p.key)),
      `listCloneProviders 全量矩阵与能力位一致（${provs.length} 家 audio 供应商）`,
    )

    // ---- [P8] parseCloneRef / validCloneRef：令牌解析与索引命中 ----
    check(parseCloneRef('clone:12') === 12 && parseCloneRef('  clone:3 ') === 3, 'parseCloneRef 正整数令牌→id（含两侧空白）')
    check(
      parseCloneRef('clone:0') === null && parseCloneRef('clone:-2') === null && parseCloneRef('clone:1.5') === null && parseCloneRef('clone:x') === null && parseCloneRef('clone:') === null,
      'parseCloneRef 非正整数/非数字 → null（不误伤普通令牌）',
    )
    check(
      parseCloneRef('alloy') === null && parseCloneRef('FunAudioLLM/CosyVoice2-0.5B:alex') === null && parseCloneRef('CLONE:5') === null && parseCloneRef(undefined) === null && parseCloneRef(null) === null,
      'parseCloneRef 非 clone 前缀（含「模型:音色」形态、大写变体、空值）→ null',
    )
    const mkClone = (over: Partial<VoiceClone>): VoiceClone => ({
      id: 901,
      name: '索引音色',
      providerKey: 'aliyun_bailian_tts',
      model: 'qwen3-tts-vc-2026-01-22',
      voiceId: 'vc-901',
      status: 'ready',
      meta: '{}',
      createdAt: T0,
      updatedAt: T0,
      ...over,
    })
    const fakeIdx = new Map<number, VoiceClone>([[901, mkClone({})]])
    check(validCloneRef('clone:901', fakeIdx)?.voiceId === 'vc-901', 'validCloneRef 令牌 + 索引命中 → 行')
    check(
      validCloneRef('clone:902', fakeIdx) === null && validCloneRef('Cherry', fakeIdx) === null && validCloneRef('clone:901') === null && validCloneRef('', fakeIdx) === null,
      'validCloneRef 索引未命中 / 非令牌 / 无索引 / 空值 → null（交由调用方降级）',
    )

    // ---- [P8] sanitizeClonePrefix：协议字符集/长度/空回退 ----
    check(sanitizeClonePrefix('Cosy Voice 2') === 'CosyVoice2', '前缀清洗：剔除空格等非法字符（qwen 协议 [A-Za-z0-9_]）')
    check(sanitizeClonePrefix('萌宝-童声A') === 'A', '前缀清洗：中文与连字符均不在白名单 → 仅留 ASCII 字母')
    check(sanitizeClonePrefix('abcdefghijklmnopqrstuvwxyz') === 'abcdefghijklmnop', '前缀清洗：截断至协议上限 16')
    check(sanitizeClonePrefix('全部中文名称') === 'voice', '前缀清洗：全非法字符 → 回退 voice（供应商侧不接受空前缀）')
    check(
      sanitizeClonePrefix('Cosy Voice 2', 'dashscope-enrollment') === 'CosyVoice2' &&
        sanitizeClonePrefix('ab_cd', 'dashscope-enrollment') === 'abcd',
      '前缀清洗按协议字符集：voice-enrollment 不收下划线（连同空格一并剔除）',
    )

    // ---- [P8] normalizeSampleMime / validateCloneSample ----
    check(
      normalizeSampleMime('audio/wav') === 'audio/wav' && normalizeSampleMime('audio/X-WAV') === 'audio/wav' && normalizeSampleMime('audio/wave') === 'audio/wav',
      'MIME 归一：wav 别名族 → audio/wav',
    )
    check(
      normalizeSampleMime('audio/mp3') === 'audio/mpeg' && normalizeSampleMime('AUDIO/MPEG; codecs=mp4a.40.2') === 'audio/mpeg',
      'MIME 归一：mp3 别名 + 大小写 + 参数后缀 → audio/mpeg',
    )
    check(
      normalizeSampleMime('video/mp4') === null && normalizeSampleMime('application/octet-stream') === null && normalizeSampleMime(undefined) === null && normalizeSampleMime('') === null,
      'MIME 白名单外/缺失 → null（硬拦截）',
    )
    const v0 = validateCloneSample({ sizeBytes: 0, mime: 'audio/mpeg' })
    check(!v0.ok && v0.issue?.code === 'empty_sample', '样本校验：空文件 → empty_sample')
    const v1 = validateCloneSample({ sizeBytes: 1024, mime: 'video/mp4' })
    check(!v1.ok && v1.issue?.code === 'bad_sample_mime' && v1.mime === null, '样本校验：非 wav/mp3 → bad_sample_mime')
    const v2 = validateCloneSample({ sizeBytes: CLONE_SAMPLE_MAX_BYTES + 1, mime: 'audio/wav' })
    check(!v2.ok && v2.issue?.code === 'too_large' && v2.issue.message.includes('10MB'), '样本校验：超 10MB → too_large（附实际体积）')
    const v3 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/mpeg', durationSec: 15 })
    check(v3.ok && v3.mime === 'audio/mpeg' && v3.issue === null && v3.warnings.length === 0, '样本校验：10~60s 区间 → 无警告通过')
    const v4 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/wav', durationSec: 5 })
    check(v4.ok && v4.warnings.length === 1 && v4.warnings[0]!.includes('低于建议值'), '时长不足→软警告不拒绝（ok 仍 true）')
    const v5 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/wav', durationSec: 90 })
    check(v5.ok && v5.warnings[0]?.includes('超出建议上限'), '时长超 60s→软警告（供应商仅取前段）')
    const v6 = validateCloneSample({ sizeBytes: 1024, mime: 'audio/wav' })
    check(v6.ok && v6.warnings[0]?.includes('未能探测'), '时长不可得（ffprobe 缺失/解析失败）→ 软警告引导自查样本')

    // ---- [P8] buildEnrollBody / parseEnrollResponse：两套 DashScope 协议快照 ----
    const bA = buildEnrollBody({ protocol: 'dashscope-qwen-enrollment', targetModel: 'qwen3-tts-vc-2026-01-22', prefix: 'probe', sampleRef: 'data:audio/mpeg;base64,AAA' })
    check(
      bA.model === 'qwen-voice-enrollment' && bA.input.action === 'create' && bA.input.preferred_name === 'probe' && JSON.stringify(bA.input.audio) === '{"data":"data:audio/mpeg;base64,AAA"}',
      `qwen 内联协议 body 快照（audio.data 承 Data URL，实际 ${JSON.stringify(bA.input.audio)}）`,
    )
    const bB = buildEnrollBody({ protocol: 'dashscope-enrollment', targetModel: 'cosyvoice-v3.5-flash', prefix: 'probe', sampleRef: 'https://cdn.example.com/a.wav' })
    check(
      typeof (bB.input as Record<string, unknown>)['target_model'] === 'string',
      '公网协议 body 快照：target_model 逐字传递',
    )
    check(
      bB.model === 'voice-enrollment' && bB.input.action === 'create_voice' && bB.input.prefix === 'probe' && bB.input.url === 'https://cdn.example.com/a.wav' && bB.input.audio === undefined,
      '公网 URL 协议 body 快照（url 字段，不下发 audio）+ target_model 逐字传递',
    )
    check(bB.parameters != null && Object.keys(bB.parameters).length === 0, 'body.parameters 恒为空对象（协议要求字段存在）')
    check(
      parseEnrollResponse({ output: { voice_id: 'cosy-x-1' } }, 'dashscope-enrollment').voiceId === 'cosy-x-1',
      '响应解析：voice-enrollment → output.voice_id',
    )
    const pe = parseEnrollResponse({ output: { voice: ' qwen-vc-1 ', fallback_mode: true, fallback_reason: 'noisy' } }, 'dashscope-qwen-enrollment')
    check(pe.voiceId === 'qwen-vc-1' && pe.fallbackMode === true && pe.fallbackReason === 'noisy', '响应解析：qwen → output.voice（trim）+ fallback 留痕')
    check(parseEnrollResponse({}, 'dashscope-qwen-enrollment').voiceId === null && parseEnrollResponse(null, 'dashscope-enrollment').voiceId === null, '响应无音色字段/空体 → voiceId null（不静默落脏行）')

    // ---- [P8] createVoiceClone 全链（fetch stub 零外发：凭证/端点/body/落行） ----
    const MP3_B64 = Buffer.from('FAKE-MP3-BYTES-FOR-PROBE-0123456789').toString('base64')
    const WAV_BYTES = new Uint8Array(Buffer.from('RIFF0000WAVEfmt 0000001000000100010044ac00006400000002001000data00000000', 'base64'))
    process.env.PROBE_M19_CLONE_KEY = 'probe-key-clone'
    await db.insert(apiConfigs).values([
      {
        providerKey: 'openai_audio',
        serviceType: 'audio',
        name: '探针通用语音',
        baseUrl: 'http://probe-openai.local/v1',
        apiKeyRef: 'env:PROBE_M19_CLONE_KEY',
        model: 'tts-1',
        extra: JSON.stringify({ voice: 'InstanceVoice' }),
        priority: 0,
        isDefault: 1,
        isActive: 1,
        createdAt: T0,
        updatedAt: T0,
      },
      {
        providerKey: 'aliyun_bailian_tts',
        serviceType: 'audio',
        name: '探针克隆语音',
        baseUrl: 'http://probe-clone.local/api/v1',
        apiKeyRef: 'env:PROBE_M19_CLONE_KEY',
        model: 'qwen-tts',
        priority: 1,
        isDefault: 0,
        isActive: 1,
        createdAt: T0,
        updatedAt: T0,
      },
    ])
    const origFetch = globalThis.fetch
    const reqs: Array<{ url: string; auth: string; body: Record<string, unknown> }> = []
    interface StubResp {
      status: number
      json: Record<string, unknown>
    }
    let enrollNext = (): StubResp => ({ status: 200, json: { output: { voice: 'qwen-vc-probe-1' } } })
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      } catch {
        body = {}
      }
      reqs.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''), body })
      if (url.includes('/audio/speech')) {
        return new Response(new Uint8Array(Buffer.from(MP3_B64, 'base64')), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      }
      if (url.includes('/customization')) {
        const r = enrollNext()
        return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ output: { audio: { data: MP3_B64 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    let cloneA!: VoiceClone
    let cloneB!: VoiceClone
    let warningsA: string[] = []
    try {
      const created = await createVoiceClone('aliyun_bailian_tts', { name: '克隆甲', sample: WAV_BYTES, mime: 'audio/wav' })
      cloneA = created.clone
      warningsA = created.warnings
      const enroll = reqs.find((r) => r.url.includes('/customization'))!
      check(enroll.url === 'http://probe-clone.local/api/v1/services/audio/tts/customization', `复刻请求落 stub customization 端点（实际 ${enroll.url}）`)
      check(enroll.auth === 'Bearer probe-key-clone', '凭证走 api_configs → env Key 解析（voice_clones 表不存密钥）')
      const inA = enroll.body.input as Record<string, unknown>
      check(
        enroll.body.model === 'qwen-voice-enrollment' && inA.action === 'create' && inA.target_model === 'qwen3-tts-vc-2026-01-22',
        `成功径 body 快照：enrollment 模型 + action + 默认目标模型（实际 ${String(enroll.body.model)}/${String(inA.action)}/${String(inA.target_model)}）`,
      )
      check(typeof inA.preferred_name === 'string' && inA.preferred_name === 'voice', '中文音色名 → 前缀清洗为协议合法值（实际 ' + String(inA.preferred_name) + '）')
      check(String((inA.audio as { data?: string }).data).startsWith('data:audio/wav;base64,'), '本地样本以 Data URL 内联下发（无需公网地址）')
      check(cloneA.id > 0 && cloneA.voiceId === 'qwen-vc-probe-1' && cloneA.status === 'ready' && cloneA.providerKey === 'aliyun_bailian_tts', '克隆成功 → 落行（供应商音色标识 + ready + 供应商归口）')
      check(cloneA.model === 'qwen3-tts-vc-2026-01-22', '落行 model = 目标克隆模型（合成时必须同模型）')
      const metaA = JSON.parse(cloneA.meta) as { protocol?: string; target_model?: string; transport?: string }
      check(metaA.protocol === 'dashscope-qwen-enrollment' && metaA.transport === 'data-uri' && metaA.target_model === 'qwen3-tts-vc-2026-01-22', 'meta 留痕协议/承载/模型（不含有敏感信息）')
      check(Array.isArray(warningsA), `warnings 数组回传（时长等软提醒 ${warningsA.length} 条）`)
      const back = await getVoiceClone(cloneA.id)
      check(back?.name === '克隆甲' && (await listVoiceClones()).length === 1, 'getVoiceClone / listVoiceClones 读回一致')

      // ---- 校验族（零副作用：不落行） ----
      const before = (await listVoiceClones()).length
      const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
        const e = await errOf(fn)
        return e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : e instanceof Error ? `nocode:${e.message.slice(0, 20)}` : 'no-error'
      }
      check((await codeOf(() => createVoiceClone('siliconflow_audio', { name: 'X', sample: WAV_BYTES, mime: 'audio/wav' }))) === 'unsupported_provider', '拦截族：未登记供应商 → unsupported_provider')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: '  ', sample: WAV_BYTES, mime: 'audio/wav' }))) === 'bad_name', '拦截族：空音色名 → bad_name')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: 'Y', sample: WAV_BYTES, mime: 'audio/wav', targetModel: 'bad model!' }))) === 'bad_target_model', '拦截族：target_model 非法字符 → bad_target_model')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: 'Y', sample: new Uint8Array(), mime: 'audio/wav' }))) === 'empty_sample', '拦截族：空样本 → empty_sample')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: 'Y', sample: WAV_BYTES, mime: 'video/mp4' }))) === 'bad_sample_mime', '拦截族：非 wav/mp3 → bad_sample_mime')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: 'Y', sample: new Uint8Array(CLONE_SAMPLE_MAX_BYTES + 1), mime: 'audio/wav' }))) === 'too_large', '拦截族：>10MB → too_large')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: '克隆甲', sample: WAV_BYTES, mime: 'audio/wav' }))) === 'dup_name', '拦截族：重名 → dup_name（唯一约束在落库阶段暴露）')
      check(
        reqs.filter((r) => r.url.includes('/customization')).length === 2,
        '前置拦截零外发：除重名（唯一约束需真插入才能触发）外，6 项校验均未调供应商端点',
      )
      check((await listVoiceClones()).length === before, '拦截族零副作用（失败不脏表）')

      // ---- 供应商错误族 ----
      enrollNext = () => ({ status: 500, json: { code: 'InvalidParameter', message: 'audio sample unreachable' } })
      const eHttp = (await errOf(() => createVoiceClone('aliyun_bailian_tts', { name: '丙', sample: WAV_BYTES, mime: 'audio/wav' }))) as {
        code?: string
        status?: number
        message?: string
      } | null
      check(eHttp?.code === 'clone_failed' && eHttp?.status === 502, `非 2xx → clone_failed 502（实际 ${String(eHttp?.code)}/${String(eHttp?.status)}）`)
      check(/InvalidParameter/.test(String(eHttp?.message)) && /audio sample unreachable/.test(String(eHttp?.message)), `错误体详情透传（${String(eHttp?.message)}）`)
      check((await listVoiceClones()).length === before, '供应商失败不落行（克隆与入库同生同灭）')
      enrollNext = () => ({ status: 200, json: {} })
      const eNoVoice = (await errOf(() => createVoiceClone('aliyun_bailian_tts', { name: '丙', sample: WAV_BYTES, mime: 'audio/wav' }))) as {
        code?: string
        status?: number
      } | null
      check(eNoVoice?.code === 'clone_no_voice', '2xx 但无音色标识 → clone_no_voice（不造空 voice 脏行）')
      enrollNext = () => ({ status: 200, json: { output: { voice_id: 'cosy-vc-2' } } })

      // ---- 公网 URL 协议（voice-enrollment）----
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: '乙', sample: WAV_BYTES, mime: 'audio/wav', protocol: 'dashscope-enrollment' }))) === 'bad_sample_transport', '公网协议下传本地样本 → bad_sample_transport（不误当 url）')
      check((await codeOf(() => createVoiceClone('aliyun_bailian_tts', { name: '乙', sampleUrl: 'ftp://a/b.wav', protocol: 'dashscope-enrollment' }))) === 'bad_sample_url', '公网协议下非 http(s) 地址 → bad_sample_url')
      const pub = await createVoiceClone('aliyun_bailian_tts', {
        name: 'Cosy Public',
        sampleUrl: 'https://cdn.example.com/a.wav',
        protocol: 'dashscope-enrollment',
        targetModel: 'cosyvoice-v3.5-flash',
      })
      cloneB = pub.clone
      const enroll2 = reqs.filter((r) => r.url.includes('/customization')).at(-1)!
      check(enroll2.body.model === 'voice-enrollment' && (enroll2.body.input as Record<string, unknown>).url === 'https://cdn.example.com/a.wav', '公网协议 body 快照：model=voice-enrollment + input.url 直传地址')
      check(cloneB.model === 'cosyvoice-v3.5-flash' && cloneB.voiceId === 'cosy-vc-2', `公网协议落行：model 取传入目标、voice_id 取 output.voice_id（${cloneB.model} / ${cloneB.voiceId}）`)
      check((await listVoiceClones()).length === 2 && (await loadCloneIndex()).size === 2, '音色库 2 行全部 ready → 声线链索引同步')

      // ---- [P8] resolveVoiceChain：旧调用签名逐字不变（probe-m3 断言口径）+ clone 各级命中 / 无效引用降级留痕 ----
      const rv1 = resolveVoiceChain({ lineVoice: 'L', charVoice: 'C', paramVoice: 'P', settingsVoice: 'S', instanceVoice: 'I' })
      check(rv1.voice === 'L' && rv1.source === 'line' && rv1.clone === null && rv1.cloneSkipped.length === 0, '旧签名：六级链首选 line，clone 字段全空（新增返回值不破坏既有消费方）')
      const rv2 = resolveVoiceChain({ lineVoice: '成年女声、清爽亲和', charVoice: 'C', instanceVoice: 'I' })
      check(rv2.voice === 'C' && rv2.source === 'character', '旧签名：语义短语级仍跳过 → 角色库令牌生效')
      const rv3 = resolveVoiceChain({})
      check(rv3.voice === 'alloy' && rv3.source === 'default' && rv3.cloneSkipped.length === 0, '旧签名：全空 → alloy/default 兜底不变')
      const rv4 = resolveVoiceChain({ charVoice: 'clone:901', paramVoice: 'P' })
      check(
        rv4.voice === 'P' && rv4.source === 'params' && rv4.clone === null && rv4.cloneSkipped.join() === 'character=clone:901',
        '旧签名（不传 cloneIndex）：clone 令牌不被原样下发（送供应商必 400）→ 记跳过并继续降级',
      )
      const rv5 = resolveVoiceChain({ lineVoice: 'clone:901', charVoice: 'C', cloneIndex: fakeIdx })
      check(rv5.voice === 'vc-901' && rv5.source === 'line' && rv5.clone?.id === 901, 'clone 命中（line 级）：voice 换供应商音色标识 + 随行返回供调用方换端点')
      const rv6 = resolveVoiceChain({ lineVoice: 'clone:99999', charVoice: 'clone:901', cloneIndex: fakeIdx })
      check(
        rv6.voice === 'vc-901' && rv6.source === 'character' && rv6.cloneSkipped.join() === 'line=clone:99999',
        '无效引用（音色库无此行）→ 跳过该级继续降级并留痕',
      )
      const rv7 = resolveVoiceChain({ lineVoice: 'clone:99999', cloneIndex: fakeIdx })
      check(rv7.voice === 'alloy' && rv7.source === 'default' && rv7.cloneSkipped.length === 1, '全链仅无效 clone 令牌 → alloy 兜底（不抛错，不中断整步配音）')

      // ---- [P8] cloneEndpoint：provider 换端点 + 模型联动（克隆与合成必须同模型）----
      const epCache = new Map<string, Awaited<ReturnType<typeof cloneEndpoint>>>()
      const epA = await cloneEndpoint(cloneA, epCache)
      check(epA.providerKey === 'aliyun_bailian_tts' && epA.baseUrl === 'http://probe-clone.local/api/v1', `cloneEndpoint 按克隆行换 provider 端点（${epA.baseUrl}）`)
      check(epA.model === cloneA.model && epA.model !== 'qwen-tts', `cloneEndpoint 覆盖 model 为克隆绑定模型（${epA.model}；实例原值 qwen-tts 被替换）`)
      const epA2 = await cloneEndpoint(cloneA, epCache)
      check(epCache.size === 1 && epA2.model === cloneA.model, '同 provider+模型复用缓存（一次查库，多句配音不重复解析）')
      const epB = await cloneEndpoint(cloneB, epCache)
      check(epCache.size === 2 && epB.model === 'cosyvoice-v3.5-flash', '同 provider 不同目标模型 → 各自缓存条目（模型串味即失效）')

      // ---- [P8] synthWithClone：试听文本上限 + 三元组下发 + 不落资产 ----
      const assetsBefore = (await db.select().from(assets)).length
      check((await codeOf(() => synthWithClone(cloneA, '   '))) === 'bad_text', '试听拦截：空白文本 → bad_text')
      check(
        (await codeOf(() => synthWithClone(cloneA, '啊'.repeat(CLONE_TEST_MAX_CHARS + 1)))) === 'bad_text',
        `试听拦截：超 ${CLONE_TEST_MAX_CHARS} 字 → bad_text（spec §2.2 ⑧）`,
      )
      reqs.length = 0
      const audioA = await synthWithClone(cloneA, '这是一段克隆音色试听。')
      const sreq = reqs[0]!
      check(audioA.byteLength > 0 && reqs.length === 1, `试听产出 mp3 字节（${audioA.byteLength} 字节，单次请求）`)
      check(
        sreq.url.includes('/services/aigc/multimodal-generation/generation') &&
          sreq.body.model === cloneA.model &&
          (sreq.body.input as Record<string, unknown>).voice === cloneA.voiceId,
        '试听请求三元组：克隆 provider 端点 + 克隆模型 + 供应商音色标识',
      )
      check((await db.select().from(assets)).length === assetsBefore, '试听不落资产（不污染素材库与用量）')

      // ---- [P8] tts 真步集成：角色库 clone:{id} → 换端点/模型/voice + 溯源 + 日志（fetch stub 零外发）----
      const { createStepContext } = await import('../../../src/pipeline/context')
      const { writeTextAsset } = await import('../../../src/services/storage')
      const { RUN_LOGS_DIR } = await import('../../../src/env')
      const { tts } = await import('../../../src/pipeline/actions/tts')
      const pidC = await mkProject('M19 声音克隆项目')
      await upsertEntity({ projectId: pidC, kind: 'character', name: '克隆童声', appearance: '圆脸大眼，虎头帽', voice: `clone:${cloneA.id}` })
      await upsertEntity({ projectId: pidC, kind: 'character', name: '普通女声', appearance: '长发，白衬衫', voice: 'Cherry' })
      const runC = (
        await db
          .insert(pipelineRuns)
          .values({ projectId: pidC, templateKey: 'mengbao-episode', status: 'running', input: '{}', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!
      const stepC = (
        await db
          .insert(pipelineSteps)
          .values({ runId: runC.id, seq: 1, stepKey: 'gen_voice', actionKey: 'tts', title: 'gen_voice', status: 'running', createdAt: T0, updatedAt: T0 })
          .returning()
      )[0]!
      const defC = { key: 'gen_voice', action: 'tts', title: 'gen_voice', inputs: {}, params: {} }
      const linesAsset = await writeTextAsset(pidC, {
        name: 'lines.json',
        content: JSON.stringify({
          lines: [
            { id: 'l1', speaker: '克隆童声', text: '第一句：我回来啦' },
            { id: 'l2', speaker: '普通女声', text: '第二句：欢迎回家' },
            { id: 'l3', speaker: '路人角色', text: '第三句：今天天气不错', voice_hint: 'clone:99999' },
          ],
        }),
        purpose: 'lines',
        format: 'json',
        stepId: stepC.id,
        runId: runC.id,
      })
      const ctxC = await createStepContext({
        run: runC,
        step: stepC,
        template: { key: 'probe-m19-voice', version: 1, name: '探针', genre: 'other', inputs: [], steps: [defC] },
        def: defC,
        input: { lines: [linesAsset.id] },
        projectSettings: {},
      })
      reqs.length = 0
      const resC = await tts(ctxC)
      check(resC.assetIds.length === 3, `tts 全链执行完成（${resC.assetIds.length}/3 句，stub 端点零外发）`)
      const synthOpenai = reqs.filter((r) => r.url.includes('/audio/speech'))
      const synthAliyun = reqs.filter((r) => r.url.includes('/multimodal-generation'))
      check(
        synthOpenai.length === 2 && synthAliyun.length === 1,
        `双 provider 派发（openai ${synthOpenai.length} 句 / aliyun ${synthAliyun.length} 句）——同一步内按句换端点`,
      )
      const areq = synthAliyun[0]!
      check(areq.body.model === cloneA.model && (areq.body.input as Record<string, unknown>).voice === cloneA.voiceId, '命中克隆句：下发 model/voice 均为克隆行值（不是 clone:N 令牌）')
      check(
        synthOpenai.map((r) => String((r.body as Record<string, unknown>).voice ?? '')).join(',') === 'Cherry,InstanceVoice',
        '非克隆句照旧走默认 audio 实例（角色令牌 / 实例 extra.voice 逐级生效）',
      )
      const voiceAssets = (await db.select().from(assets)).filter((a) => a.purpose === 'voice' && a.runId === runC.id)
      const vpOf = (lineId: string): Record<string, unknown> =>
        JSON.parse(voiceAssets.find((a) => (JSON.parse(a.params ?? '{}') as { lineId?: string }).lineId === lineId)?.params ?? '{}') as Record<string, unknown>
      const vp1 = vpOf('l1')
      check(
        vp1.voiceSource === 'clone' &&
          vp1.clone_id === cloneA.id &&
          vp1.clone_name === cloneA.name &&
          vp1.clone_level === 'character' &&
          vp1.model === cloneA.model &&
          vp1.provider === 'aliyun_bailian_tts',
        '溯源入 asset.params：voiceSource=clone + clone_id/clone_name/clone_level + 实际 model/provider',
      )
      check(vp1.voice === cloneA.voiceId, 'params.voice 记真实下发音色（可复现可替换）')
      const vp3 = vpOf('l3')
      check(
        vp3.voiceSource === 'instance' && vp3.clone_id === null && vp3.clone_level === null && vp3.voiceHint === 'clone:99999',
        '无效引用句：按实际下发级记 source、clone_* 置空、voiceHint 原样留痕（可审计）',
      )
      const usC = await db.select().from(usageRecords).where(eq(usageRecords.projectId, pidC))
      check(
        usC.length === 3 && usC.filter((u) => u.provider === 'aliyun_bailian_tts' && u.model === cloneA.model).length === 1,
        `用量逐句记录且按克隆 provider/模型归口（${usC.length} 行）`,
      )
      const logTxtC = existsSync(join(RUN_LOGS_DIR, `${runC.id}.log`)) ? readFileSync(join(RUN_LOGS_DIR, `${runC.id}.log`), 'utf8') : ''
      check(logTxtC.includes('音色库 2 个克隆音色可引用 clone:{id}'), '步日志：音色库规模提示（仅 ready 行 ≥1 时输出，无克隆行时旧日志逐字不变）')
      check(logTxtC.includes('克隆音色引用未命中（line=clone:99999）'), '步日志：无效引用跳过留痕（spec §5 验收口径）')

      // ---- [P8] deleteVoiceClone + 删除后存量引用自动降级 ----
      check((await codeOf(() => deleteVoiceClone(0))) === 'bad_id', '删除拦截：非正整数 id → bad_id')
      const eDel = (await errOf(() => deleteVoiceClone(99999))) as { code?: string; status?: number } | null
      check(eDel?.code === 'not_found' && eDel?.status === 404, '删除：查无此行 → not_found 404')
      const delA = await deleteVoiceClone(cloneA.id)
      check(delA.name === cloneA.name && (await loadCloneIndex()).size === 1, '删除成功 → 音色库与声线链索引同步缩减')
      const rv8 = resolveVoiceChain({ charVoice: `clone:${cloneA.id}`, cloneIndex: await loadCloneIndex() })
      check(rv8.voice === 'alloy' && rv8.cloneSkipped.join() === `character=clone:${cloneA.id}`, '删除后存量角色引用自动降级（不会误用已失效音色）')
      await deleteVoiceClone(cloneB.id)
      check((await listVoiceClones()).length === 0, '音色库收尾清空（探针不留行）')
    } finally {
      globalThis.fetch = origFetch
      await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, 'audio'))
      delete process.env.PROBE_M19_CLONE_KEY
    }
    check((await db.select().from(apiConfigs).where(eq(apiConfigs.serviceType, 'audio'))).length === 0, '集成段收尾清理 audio 端点与密钥环境变量（不污染后续节）')
  }
}
