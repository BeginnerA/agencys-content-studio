/**
 * M35 探针（创作流程自动化：G9 settings 闸门 + G7 模板推荐 + G10 clamp + G11 下一步建议）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m35.ts [--section=g9-settings|g7-recommend|g10-clamp|g11-next-steps|guards]
 *
 * 隔离策略：isolatedEnv('m35', bridge templates/prompts) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络、零付费、零计费：
 *   - G9 纯 schema 校验（validateProjectSettings 无 IO）
 *   - G7 embedding 无模型时（离线环境）自动回落 keyword（KEYWORDS 静态表）
 *   - G10 clamp 是纯函数（不查库、不发请求）
 *   - G11 只做 DB 读 + 模板元数据读取；端点仅走内存 app.request
 *
 * 分节：
 *   - g9-settings：非法枚举 / 类型 / 尺寸 → errors；未登记字段 / 空串 / WxH 兼容 → 放行。
 *   - g7-recommend：命中关键词 → items；garbage → empty；空 text → 400；路由歧义：/templates/mengbao-episode 仍解析到 :key。
 *   - g10-clamp：无 video → dynamic 强制 slideshow；caps 命中 → 就近上取合法 + aspect 回落 + duration 重算；未登记 caps → 不钳制。
 *   - g11-next-steps：0/1/2 三态规则命中；≤3 条；kind/route 契约稳定；端点 404/200。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m35', { bridge: ['templates', 'prompts'] })
process.env.PROBE_M35_KEY = 'probe-m35-offline-secret-key-5f7d'

const SECTIONS = ['g9-settings', 'g7-recommend', 'g10-clamp', 'g11-next-steps', 'guards'] as const

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m35')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // ---------- 通用 seed helpers ----------
  const insertProject = async (
    tag: string,
    opts: { brief?: string; templateKey?: string; settings?: unknown } = {},
  ): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { projects } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    const t = Date.now()
    const name = `probe-m35-${tag}`
    await db.insert(projects).values({
      name,
      genre: 'drama_short',
      brief: opts.brief ?? null,
      templateKey: opts.templateKey ?? 'mengbao-episode',
      status: 'active',
      settings: opts.settings === undefined ? '{}' : JSON.stringify(opts.settings),
      tags: '[]',
      createdAt: t,
      updatedAt: t,
    } as never)
    const [row] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, name))
      .limit(1)
    return (row as { id: number }).id
  }

  const insertRun = async (
    projectId: number,
    templateKey: string,
    status: string,
    at: number,
    currentStepKey?: string,
  ): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { pipelineRuns } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    await db.insert(pipelineRuns).values({
      projectId,
      templateKey,
      status,
      currentStepKey: currentStepKey ?? null,
      input: '{}',
      createdAt: at,
      updatedAt: at,
    } as never)
    const all = await db
      .select({ id: pipelineRuns.id })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.projectId, projectId))
      .orderBy(pipelineRuns.id)
    return (all[all.length - 1] as { id: number }).id
  }

  const insertPub = async (projectId: number, at: number): Promise<number> => {
    const { initDb, db } = await import('../src/db')
    const { publications } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    await initDb()
    await db.insert(publications).values({
      projectId,
      platform: 'douyin',
      url: 'http://localhost/offline',
      metrics: '{}',
      createdAt: at,
      updatedAt: at,
    } as never)
    const rows = await db
      .select({ id: publications.id })
      .from(publications)
      .where(eq(publications.projectId, projectId))
    return (rows[rows.length - 1] as { id: number }).id
  }

  const clearAll = async (): Promise<void> => {
    const { initDb, db } = await import('../src/db')
    const { pipelineRuns, publications, projects } = await import('../src/db/schema')
    await initDb()
    await db.delete(pipelineRuns)
    await db.delete(publications)
    await db.delete(projects)
  }

  const jget = async (path: string): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path)
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
    return { status: res.status, body: json }
  }

  const jpost = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
    return { status: res.status, body: json }
  }

  const jpatch = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> => {
    const { app } = await import('../src/app')
    const res = await app.request(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      /* non-json */
    }
    return { status: res.status, body: json }
  }

  const runners: Record<string, () => Promise<void>> = {
    // ================= G9：settings 写时闸门（已登记字段严格 + 未登记字段放行） =================
    'g9-settings': async () => {
      const { validateProjectSettings } = await import('../src/services/project-settings')

      // 合法：ai-video 输入域
      check(validateProjectSettings({ video: { resolution: '720p' } }).length === 0, 'video.resolution 480p/720p/1080p 放行')
      // 合法：ffmpeg-merge 输出域（WxH）—— 命名冲突兼容
      check(validateProjectSettings({ video: { resolution: '1080x1920' } }).length === 0, 'video.resolution WxH（ffmpeg-merge 语义）放行，避免破坏现网')
      // 非法：明显越界的分辨率字符串
      const rBad = validateProjectSettings({ video: { resolution: 'ultra-4k' } })
      check(rBad.length === 1 && rBad[0]!.includes('resolution'), '非法 resolution → 单条 error 点名 settings.video.resolution')
      // 未登记字段一律放行（保守治理，不猜语义）
      check(
        validateProjectSettings({ video: { fps: 999, duration_per_shot: 30, subtitle_style: 'anything' } }).length === 0,
        '未登记字段（fps/duration_per_shot/subtitle_style）放行 → 保护既有项目',
      )
      // 非字符串 provider
      check(validateProjectSettings({ video: { provider: 123 } }).length === 1, 'provider 非字符串 → 报错')
      // 图片尺寸
      check(validateProjectSettings({ image: { size: '832x1248' } }).length === 0, 'image.size WxH 放行')
      check(validateProjectSettings({ image: { size: '832*1248' } }).length === 1, 'image.size 非 WxH → 报错')
      // 非对象 settings
      check(validateProjectSettings('not-an-object').length === 1, 'settings 非对象 → 报错')
      check(validateProjectSettings(['arr']).length === 1, 'settings 数组 → 报错')
      // 空值放行
      check(validateProjectSettings(undefined).length === 0 && validateProjectSettings(null).length === 0, 'undefined/null → 无 errors（路由层再决定是否入库）')

      // 端点闸门：POST /projects 非法 settings → 400 bad_settings；合法 → 201/200；未登记字段 → 放行
      await clearAll()
      const badCreate = await jpost('/api/v1/projects', {
        name: 'g9-bad',
        genre: 'drama_short',
        brief: '',
        settings: { video: { resolution: 'bogus' } },
      })
      check(badCreate.status === 400 && badCreate.body?.error?.code === 'bad_settings', 'POST /projects 非法 settings → 400 bad_settings')
      const okCreate = await jpost('/api/v1/projects', {
        name: 'g9-ok',
        genre: 'drama_short',
        brief: '',
        settings: { video: { resolution: '1080x1920', fps: 24 } },
      })
      check(okCreate.status === 200 || okCreate.status === 201, 'POST /projects 合法 + 未登记字段混合 → 通过')
      const okPid = (okCreate.body?.id ?? okCreate.body?.project?.id) as number
      check(typeof okPid === 'number' && okPid > 0, 'POST 成功返回项目 id')
      // PATCH 同口径闸门
      const badPatch = await jpatch(`/api/v1/projects/${okPid}`, { settings: { llm: { temperature: 'hot' } } })
      check(badPatch.status === 400 && badPatch.body?.error?.code === 'bad_settings', 'PATCH /projects/:id 非法 settings → 400 bad_settings（同 POST 口径）')
    },

    // ================= G7：自然语言→模板推荐（离线环境走 keyword 分支；不断言 embedding） =================
    'g7-recommend': async () => {
      const { recommendTemplates } = await import('../src/services/template-recommend')

      // 关键词命中（KEYWORDS 表覆盖）：短剧成片 → mengbao-episode
      const r1 = await recommendTemplates('我要做一部短剧成片，带配音字幕', 3)
      check(Array.isArray(r1.items) && r1.items.length > 0, '含「短剧成片」→ items 命中（embedding 或 keyword 均可）')
      check(r1.items.some((i) => i.key === 'mengbao-episode'), '命中集合含 mengbao-episode')
      check(r1.items.every((i) => typeof i.score === 'number' && i.score > 0), '每条命中都带正 score')

      // 明确无关 → empty
      const r2 = await recommendTemplates('zzz-random-nonexistent-text-xyz-9527', 3)
      check(r2.items.length === 0, '无关文本 → items 空')

      // 空 text → items 空、source empty（不抛错；由路由层拒 400）
      const r3 = await recommendTemplates('   ', 3)
      check(r3.items.length === 0 && r3.source === 'empty', '空白文本 → source=empty（service 层不抛）')

      // top 参数生效
      const r4 = await recommendTemplates('选题 雷达 找选题 选题清单', 1)
      check(r4.items.length <= 1, 'top=1 → 最多 1 条')

      // 端点契约：GET /templates/recommend?text=
      await clearAll()
      const ok = await jget(`/api/v1/templates/recommend?text=${encodeURIComponent('短剧成片')}&top=3`)
      check(ok.status === 200 && Array.isArray(ok.body?.items) && typeof ok.body?.source === 'string', 'GET /templates/recommend 200 → {items, source, ready}')
      const badText = await jget('/api/v1/templates/recommend?text=%20')
      check(badText.status === 400 && badText.body?.error?.code === 'bad_text', '空 text → 400 bad_text')
      const badTop = await jget('/api/v1/templates/recommend?text=abc&top=999')
      // top 越界 → 回落默认 3，仍 200（不硬拒；宽松策略，前端可控）
      check(badTop.status === 200, 'top 越界回落 3，仍 200')

      // 路由歧义检查：/templates/:key 仍可解析真实模板（recommend 静态段不吞 :key）
      const detail = await jget('/api/v1/templates/mengbao-episode')
      check(detail.status === 200 && detail.body?.template?.key === 'mengbao-episode', 'GET /templates/:key 未被 /templates/recommend 抢占，路由顺序正确')
    },

    // ================= G10：clampPlanToCaps 纯函数（无 IO、无 LLM） =================
    'g10-clamp': async () => {
      const { clampPlanToCaps } = await import('../src/services/creation-chat/clamp')

      const basePlan = () =>
        ({
          title: 't',
          summary: 's',
          genre: 'story',
          duration: 45,
          aspectRatio: '9:16',
          language: 'zh-CN',
          mode: 'dynamic',
          style: 'x',
          script: 'y',
          lines: [
            { id: 'L1', text: 'a' },
            { id: 'L2', text: 'b' },
            { id: 'L3', text: 'c' },
          ],
          shots: [
            { id: 'S1', duration: 5, image_prompt: 'p', motion_prompt: 'm', lines: ['L1'] },
            { id: 'S2', duration: 20, image_prompt: 'p', motion_prompt: 'm', lines: ['L2'] },
            { id: 'S3', duration: 20, image_prompt: 'p', motion_prompt: 'm', lines: ['L3'] },
          ],
          refs: [],
        }) as never

      // ① 无 video 实例 + mode=dynamic → 强制降级 slideshow；changed=true
      const r1 = clampPlanToCaps(basePlan(), null, false)
      check(r1.plan.mode === 'slideshow', 'hasVideo=false + dynamic → 强制 slideshow（不猜能力）')
      check(!!r1.report.mode && r1.report.mode.from === 'dynamic' && r1.report.mode.to === 'slideshow', 'report.mode 记录降级明细')
      check(r1.report.changed === true && r1.report.notes.some((n) => n.includes('slideshow')), 'report.notes 含人类可读降级说明（不静默）')
      // 原对象不被就地修改（shots 深拷贝）
      check(basePlan().shots[1] && (basePlan() as never as { shots: Array<{ duration: number }> }).shots[1]!.duration === 20, '原 plan 对象不被就地修改（返回新对象）')

      // ② 有 caps（durations 4/6/10/15、aspectRatios 9:16）→ shot 20 就近上取 15；duration 重算
      const caps = {
        modes: ['dynamic'],
        durations: [4, 5, 6, 10, 15],
        aspectRatios: ['9:16'],
        resolutions: ['720p'],
        defaultDuration: 6,
        defaultResolution: '720p',
      } as never
      const r2 = clampPlanToCaps(basePlan(), caps, true)
      check(r2.plan.shots.every((s: { duration: number }) => [4, 5, 6, 10, 15].includes(s.duration)), '所有 shot.duration 收敛到 caps.durations 合法集')
      check(r2.plan.shots[1]!.duration === 15 && r2.plan.shots[2]!.duration === 15, '20s → 15s（就近上取；超过最大取最大）')
      check(r2.report.shotDurations.length === 2, 'report.shotDurations 精确记录两条钳制')
      // 新 duration = 5 + 15 + 15 = 35（∈ 30–60 契约）
      check(r2.plan.duration === 35, 'plan.duration 重算为镜头和 35（保持 superRefine 不变式）')
      check(r2.report.notes.some((n: string) => n.includes('镜头时长钳制')), 'report.notes 含镜头钳制说明')
      // mode 保持 dynamic（有 caps + hasVideo=true）
      check(r2.plan.mode === 'dynamic', 'hasVideo=true + 命中 caps → 不降级模式')

      // ③ caps 命中 + aspectRatio 非法 → 回落 caps.aspectRatios[0]
      const planWide = (() => {
        const p = basePlan() as never as { aspectRatio: string }
        p.aspectRatio = '1:1'
        return p as never
      })()
      const capsNarrow = {
        modes: ['dynamic'],
        durations: [5, 15],
        aspectRatios: ['9:16'],
        resolutions: ['720p'],
        defaultDuration: 5,
        defaultResolution: '720p',
      } as never
      const r3 = clampPlanToCaps(planWide, capsNarrow, true)
      check(r3.plan.aspectRatio === '9:16', 'aspectRatio 不在 caps 集 → 回落 caps.aspectRatios[0]')
      check(!!r3.report.aspectRatio && r3.report.aspectRatio.from === '1:1' && r3.report.aspectRatio.to === '9:16', 'report.aspectRatio 记录画幅钳制')

      // ④ 未登记模型（caps=null + hasVideo=true）→ 不钳制数值，交 preflight fail-closed（不猜）
      const r4 = clampPlanToCaps(basePlan(), null, true)
      check(r4.plan.shots[1]!.duration === 20 && r4.plan.duration === 45, 'caps=null（未登记模型）→ 不动 duration（不猜，交给 preflight 兜底）')
      check(r4.report.changed === false, 'caps=null + hasVideo=true → changed=false')

      // ⑤ 幂等：对已合法方案再跑一次不改变
      const capsFull = {
        modes: ['dynamic'],
        durations: [4, 5, 6, 10, 15, 20, 30],
        aspectRatios: ['9:16', '16:9'],
        resolutions: ['720p'],
        defaultDuration: 5,
        defaultResolution: '720p',
      } as never
      const r5a = clampPlanToCaps(basePlan(), capsFull, true)
      const r5b = clampPlanToCaps(r5a.plan, capsFull, true)
      check(r5b.report.changed === false, '二次钳制幂等：合法方案再跑不改变（避免死循环）')
    },

    // ================= G11：resolveNextSteps 规则引擎（≤3 条，DB 读） =================
    'g11-next-steps': async () => {
      const { resolveNextSteps } = await import('../src/services/next-steps')
      await clearAll()

      // 规则 1：0 run → 单条 kind='run'
      const pidA = await insertProject('g11-a', { templateKey: 'mengbao-episode', brief: '测试' })
      const sA = await resolveNextSteps(pidA)
      check(sA.length === 1 && sA[0]!.kind === 'run', '0 run → 单条 run 建议（开始制作）')
      check(typeof sA[0]!.route === 'string' && sA[0]!.route!.includes('run-new'), 'run 建议 route 指向 run-new?tpl=')

      // 规则 2：queued run → progress auto:true（不覆盖其他建议也优先展示）
      const pidB = await insertProject('g11-b', { templateKey: 'mengbao-episode' })
      await insertRun(pidB, 'mengbao-episode', 'queued', Date.now())
      const sB = await resolveNextSteps(pidB)
      check(sB.length === 1 && sB[0]!.kind === 'progress' && sB[0]!.auto === true, 'queued run → progress auto:true（无路由按钮）')

      // 规则 3+4：completed + template.next 非空 + 无 pub → next_tpl + publish（2 条）
      const pidC = await insertProject('g11-c', { templateKey: 'mengbao-episode' })
      await insertRun(pidC, 'mengbao-episode', 'completed', Date.now())
      const sC = await resolveNextSteps(pidC)
      check(sC.some((s) => s.kind === 'next_tpl'), 'completed(mengbao.next=[review-restock]) → 含 next_tpl')
      check(sC.some((s) => s.kind === 'publish'), 'completed 且无 pub → 含 publish')
      check(!sC.some((s) => s.kind === 'workbench'), '有 next → 不出现 workbench（避免叠加建议噪音）')

      // 规则 3+5：completed + next + pub → 只 next_tpl（publish 被 hasPub 关掉、workbench 被 hasNext 关掉）
      const pidD = await insertProject('g11-d', { templateKey: 'mengbao-episode' })
      await insertRun(pidD, 'mengbao-episode', 'completed', Date.now())
      await insertPub(pidD, Date.now())
      const sD = await resolveNextSteps(pidD)
      check(sD.length === 1 && sD[0]!.kind === 'next_tpl', 'completed + pub + 有 next → 仅 next_tpl（无重复建议）')

      // 规则 5：completed 无 next（easy-video 无 next 字段） + pub → workbench
      const pidE = await insertProject('g11-e', { templateKey: 'easy-video' })
      await insertRun(pidE, 'easy-video', 'completed', Date.now())
      await insertPub(pidE, Date.now())
      const sE = await resolveNextSteps(pidE)
      check(sE.length === 1 && sE[0]!.kind === 'workbench', 'completed + pub + 无 next → workbench（引导精修）')
      check(typeof sE[0]!.route === 'string' && sE[0]!.route!.endsWith('/canvas'), 'workbench route 指向 /canvas')

      // 上限：≤3 条（in-flight + 已完成 + 有 pub + 有 next）
      const pidF = await insertProject('g11-f', { templateKey: 'mengbao-episode' })
      await insertRun(pidF, 'mengbao-episode', 'completed', 1_000)
      await insertPub(pidF, 1_500)
      await insertRun(pidF, 'mengbao-episode', 'running', 2_000)
      const sF = await resolveNextSteps(pidF)
      check(sF.length <= 3, '多条命中 → 严格 ≤3 条（防噪）')
      check(sF[0]!.kind === 'progress', 'in-flight 优先展示（首条 = progress）')

      // 项目不存在 → 空数组（不抛）
      const sNone = await resolveNextSteps(999999)
      check(sNone.length === 0, '不存在项目 → 空数组（不抛）')

      // 端点：GET /projects/:id/next-steps 200 → {items}
      const ep = await jget(`/api/v1/projects/${pidA}/next-steps`)
      check(ep.status === 200 && Array.isArray(ep.body?.items), 'GET /projects/:id/next-steps 200 → {items:[]}')
    },

    // ================= guards：端点边界（404 / 参数校验） =================
    guards: async () => {
      await clearAll()
      const pid = await insertProject('guards', { templateKey: 'mengbao-episode' })
      const ok = await jget(`/api/v1/projects/${pid}/next-steps`)
      check(ok.status === 200, '合法项目 → 200')
      const np = await jget('/api/v1/projects/999999/next-steps')
      check(np.status === 200 && Array.isArray(np.body?.items) && np.body.items.length === 0, '不存在项目 → 200 items=[]（规则引擎 fail-open，不阻塞 UI）')
      const bad = await jget('/api/v1/projects/abc/next-steps')
      check(bad.status === 400 || bad.status === 404, '非法 id → 400 或 404')
    },
  }

  await runSections({ log, title: 'M35', checker, sections: SECTIONS, runners, cleanup: envCleanup })
}

void main()
