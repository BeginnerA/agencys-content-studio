import type { Checker } from '../../probe-lib'

export async function probeAsr({ check }: Checker): Promise<void> {
  const kit = await import('@agencys/ai-provider-kit')
  const parse = kit.parseTimestampedTranscript
  check(typeof parse === 'function', '严格 ASR 解析入口存在')
  if (typeof parse !== 'function') return
  const valid = { text: '别着急，我陪你找。', segments: [{ start: 0.5, end: 1.2, text: '别着急，' }, { start: 1.3, end: 2.5, text: '我陪你找。' }] }
  const throws = (fn: () => unknown) => { try { fn(); return false } catch { return true } }
  check(parse(valid, 8).segments.length === 2, '保留实际分段时间戳')
  for (const bad of [
    { text: '你好' },
    { ...valid, segments: [] },
    { text: '， ', segments: [{ start: 0, end: 1, text: '， ' }] },
    { ...valid, segments: [{ start: '0', end: 3, text: valid.text }] },
    { ...valid, segments: [{ start: 0, end: Infinity, text: valid.text }] },
    { ...valid, text: '另一句话' },
    { ...valid, segments: [{ start: NaN, end: 3, text: valid.text }] },
    { ...valid, segments: [{ start: -1, end: 3, text: valid.text }] },
    { ...valid, segments: [{ start: 4, end: 3, text: valid.text }] },
    { ...valid, segments: [{ start: 1, end: 9, text: valid.text }] },
    { ...valid, segments: [{ start: 1, end: 3, text: '别着急' }, { start: 2, end: 4, text: '我陪你找' }] },
    { ...valid, segments: [{ start: null, end: 3, text: valid.text }] },
  ]) check(throws(() => parse(bad, 8)), '缺失、不自洽或非法时间戳被拒绝')
  check(kit.normalizeDialogueText('Ａ１２， 你好！') === 'A12你好', '仅归一 Unicode、标点和空白')
  check(kit.normalizeDialogueText('12') !== kit.normalizeDialogueText('十二'), '不猜数字语义等价')
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    const form = init?.body as FormData
    check(String(input) === 'http://localhost:0/v1/audio/transcriptions', '固定转写端点')
    check(form.get('model') === 'whisper-1' && form.get('response_format') === 'verbose_json', '固定支持时间戳的模型与响应格式')
    check(form.get('timestamp_granularities[]') === 'segment', '请求真实分段时间戳')
    return Response.json(valid)
  }
  try {
    const result = await kit.requestTimestampedTranscription({ baseUrl: 'http://localhost:0/v1', apiKey: 'offline', model: 'whisper-1', audio: new Uint8Array([1, 2, 3]) })
    check(parse(result, 8).text === valid.text && calls === 1, '单次转写返回原始数据供校验留存')
    globalThis.fetch = async () => { calls++; return new Response('不可回显的供应商响应', { status: 503 }) }
    let message = ''
    try { await kit.requestTimestampedTranscription({ baseUrl: 'http://localhost:0/v1', apiKey: 'offline', model: 'whisper-1', audio: new Uint8Array([1]) }) } catch (err) { message = String(err) }
    check(calls === 2 && message.includes('503') && !message.includes('不可回显'), '请求失败不重试、不回显响应体')
    for (const override of [{ model: 'tts-1' }, { audio: new Uint8Array() }, { baseUrl: 'file:///tmp' }, { baseUrl: 'https://secret:pwd@example.com' }]) {
      let rejected = false
      try { await kit.requestTimestampedTranscription({ baseUrl: 'http://localhost:0/v1', apiKey: 'offline', model: 'whisper-1', audio: new Uint8Array([1]), ...override }) } catch { rejected = true }
      check(rejected && calls === 2, '未知模型、空音轨、非法端点在请求前拒绝')
    }
    globalThis.fetch = async () => { calls++; return new Response('非 JSON') }
    message = ''
    try { await kit.requestTimestampedTranscription({ baseUrl: 'http://localhost:0/v1', apiKey: 'offline', model: 'whisper-1', audio: new Uint8Array([1]) }) } catch (err) { message = String(err) }
    check(calls === 3 && message.includes('JSON'), '非法响应不会重发')
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      calls++
      const timer = setTimeout(() => reject(new Error('测试超时守卫')), 500)
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('供应商敏感错误')) }, { once: true })
    })
    message = ''
    try { await kit.requestTimestampedTranscription({ baseUrl: 'http://localhost:0/v1', apiKey: 'offline', model: 'whisper-1', audio: new Uint8Array([1]), timeoutMs: 10 }) } catch (err) { message = String(err) }
    check(calls === 4 && message.includes('超时') && !message.includes('敏感'), '超时中止请求并要求核验，不自动重试')
  } finally { globalThis.fetch = original }
}
