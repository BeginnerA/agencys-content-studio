/** M16③ edit-cap：适配器编辑声明与请求构造快照（fetch 记录器拦截，零网络）（断言体逐字搬自原 probe-m16.ts） */
import type { M16Ctx } from './ctx'

export async function run(ctx: M16Ctx): Promise<void> {
  const { check, jsonRes, stubFetch, editCapabilityOf } = ctx
  const { AliyunWanImageAdapter } = await import('../../../src/adapters/aliyun-wan-image')
  const { AliyunQwenImageAdapter } = await import('../../../src/adapters/aliyun-qwen-image')
  const wan = new AliyunWanImageAdapter()
  check(wan.editing?.inpaint === true && wan.editing?.outpaint === true, 'aliyun-wan editing 声明 {inpaint, outpaint}')
  check(typeof wan.edit === 'function', 'aliyun-wan edit 方法存在')
  const qwen = new AliyunQwenImageAdapter()
  check((qwen as any).editing === undefined, '未声明适配器（aliyun-qwen）→ editing undefined')

  const capNone = await editCapabilityOf()
  check(capNone.inpaint === false && capNone.erase === false && capNone.outpaint === false, 'editCapabilityOf 无端点配置 → 全 false')

  // fetch 记录器：奇数次调用 = 提交（返回 task_id），偶数次 = 轮询（返回结果）
  const calls: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(url), body })
    if (calls.length % 2 === 1) return jsonRes({ output: { task_id: `probe-edit-${calls.length}` } })
    return jsonRes({ output: { task_status: 'SUCCEEDED', results: [{ url: 'https://probe.local/out.png' }] } })
  }) as typeof fetch
  try {
    // inpaint
    const r1 = await wan.edit({
      mode: 'inpaint',
      baseImage: 'data:image/png;base64,AA',
      mask: 'data:image/png;base64,BB',
      prompt: '换成红色',
      baseUrl: 'http://probe.local',
      apiKey: 'k',
    })
    check(r1.kind === 'url' && r1.url === 'https://probe.local/out.png', 'wan.edit inpaint → 出图 URL')
    const submit1 = calls[0]!
    check(submit1.url.includes('/services/aigc/image2image/image-synthesis'), 'wan.edit 提交端点 image2image/image-synthesis')
    check(
      submit1.body?.model === 'wanx2.1-imageedit' &&
        submit1.body?.input?.function === 'description_edit_with_mask' &&
        submit1.body?.input?.mask_image_url === 'data:image/png;base64,BB' &&
        submit1.body?.input?.prompt === '换成红色' &&
        submit1.body?.input?.base_image_url === 'data:image/png;base64,AA',
      'wan.edit inpaint 请求体快照（function/mask/prompt/base）',
    )
    check(calls[1]?.url.includes('/tasks/probe-edit-1'), 'wan.edit 轮询任务端点')
    // erase 无 prompt → 默认词
    await wan.edit({ mode: 'erase', baseImage: 'data:image/png;base64,AA', mask: 'data:image/png;base64,CC', baseUrl: 'http://probe.local', apiKey: 'k' })
    check(
      calls[2]?.body?.input?.prompt === '去除涂抹区域的物体，并用周围背景自然填补',
      'wan.edit erase 无指令 → 默认提示词',
    )
    // outpaint expand
    await wan.edit({
      mode: 'outpaint',
      baseImage: 'data:image/png;base64,AA',
      expand: { angle: 30, xScale: 1.5, yScale: 2 },
      baseUrl: 'http://probe.local',
      apiKey: 'k',
    })
    const submit3 = calls[4]!
    check(
      submit3.body?.input?.function === 'expand' &&
        submit3.body?.parameters?.angle === 30 &&
        submit3.body?.parameters?.x_scale === 1.5 &&
        submit3.body?.parameters?.y_scale === 2 &&
        submit3.body?.input?.mask_image_url === undefined,
      'wan.edit outpaint 请求体快照（function=expand + parameters 三元组）',
    )
    // 本地校验：inpaint 缺 mask → 抛且不发请求
    const before = calls.length
    let threw = false
    try {
      await wan.edit({ mode: 'inpaint', baseImage: 'data:image/png;base64,AA', prompt: 'x', baseUrl: 'http://probe.local', apiKey: 'k' })
    } catch {
      threw = true
    }
    check(threw && calls.length === before, 'wan.edit inpaint 缺 mask → 本地抛错（零请求）')
  } finally {
    globalThis.fetch = stubFetch
  }
}
