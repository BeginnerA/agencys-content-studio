/** M41：隔离数据库与素材目录；所有网络默认阻断，不运行收费生成。 */
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const env = isolatedEnv('m41', { bridge: ['templates', 'prompts'] })
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('探针禁止外部网络') }

async function main() {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m41')
  const checker = makeChecker(log)
  const check = checker.check
  await runSections({ log, title: 'M41', checker, sections: ['projection', 'first-input', 'first-input-client'], cleanup: () => { globalThis.fetch = originalFetch; env.cleanup() }, runners: {
    projection: async () => {
      const { db, initDb } = await import('../src/db')
      const { projects, creationSessions, pipelineRuns, pipelineSteps, genTasks, assets } = await import('../src/db/schema')
      const { projectCreation } = await import('../src/services/creation-chat/projection')
      const { creationDetail, listCreationSessions } = await import('../src/services/creation-chat/store')
      const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
      const { registerAsset, ensureProjectDirs, relPathOf, absPathOf } = await import('../src/services/storage')
      const { writeFileSync } = await import('node:fs')
      const { eq } = await import('drizzle-orm')
      await initDb()
      const now = Date.now()
      const plan = creationPlanSchema.parse({ title: '七镜测试', summary: '阶段及恢复展示', genre: 'science', duration: 35, mode: 'dynamic', style: '清晰', script: '七句台词',
        lines: Array.from({ length: 7 }, (_, i) => ({ id: `l${i}`, text: `台词${i}` })),
        shots: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, duration: 5, image_prompt: '画面', motion_prompt: '动态', lines: [`l${i}`] })),
      })
      const [project] = await db.insert(projects).values({ name: 'M41', genre: 'other', status: 'draft', createdAt: now, updatedAt: now }).returning()
      const projectId = project!.id
      const [run] = await db.insert(pipelineRuns).values({ projectId, templateKey: 'easy-video', status: 'failed', error: '相同错误', input: JSON.stringify({ recipe: JSON.stringify({ plan, videoMode: 'i2v' }) }), createdAt: now, updatedAt: now }).returning()
      const [session] = await db.insert(creationSessions).values({ projectId, requestKey: 'projection-m41', status: 'started', plan: JSON.stringify(plan), approvedPlan: JSON.stringify(plan), runId: run!.id, createdAt: now, updatedAt: now }).returning()
      const steps = await db.insert(pipelineSteps).values(['voice', 'captions', 'images', 'frames', 'motion', 'compose'].map((key, i) => ({ runId: run!.id, seq: i, stepKey: key, actionKey: key, title: key, status: ['voice', 'captions', 'frames'].includes(key) ? 'succeeded' : key === 'images' ? 'skipped' : key === 'motion' ? 'failed' : 'pending', error: key === 'motion' ? '相同错误' : null, createdAt: now, updatedAt: now }))).returning()
      ensureProjectDirs(projectId)
      const media: typeof assets.$inferSelect[] = []
      for (const key of ['voice', 'frames']) {
        const step = steps.find((s) => s.stepKey === key)!
        const output: number[] = []
        for (let i = 0; i < 7; i++) {
          const relPath = relPathOf(projectId, 'source', `${key}-${i}.txt`)
          writeFileSync(absPathOf(relPath), 'offline-fixture')
          const a = await registerAsset(projectId, { name: `${key}-${i}`, kind: key === 'voice' ? 'audio' : 'image', relPath, runId: run!.id, stepId: step.id, params: key === 'voice' ? { lineId: `l${i}` } : { shotId: `s${i}` } })
          media.push(a); output.push(a.id)
          await db.insert(genTasks).values({ projectId, runId: run!.id, stepId: step.id, kind: a.kind, params: a.params!, status: 'succeeded', resultAssetId: a.id, createdAt: now, updatedAt: now })
        }
        step.output = JSON.stringify({ asset_ids: output })
        await db.update(pipelineSteps).set({ output: step.output }).where(eq(pipelineSteps.id, step.id))
      }
      let tasks = await db.select().from(genTasks)
      tasks.push({ ...tasks[0]!, id: 999 })
      let p = projectCreation(session!, run!, steps, tasks, media)
      const stage = (key: string) => p.progress.stages.find((s) => s.key === key)!
      check(stage('voice').completed === 7 && stage('frames').completed === 7, '七句配音/七张首帧成功，重复任务不放大计数')
      check(stage('motion').completed === null && stage('motion').status === 'failed', '无子任务时显示真实步骤失败，不编造比例')
      check(p.progress.stages.filter((s) => s.applicable === true && s.status === 'succeeded').length === 3, '视频未成功仍有三个阶段完成')
      check(p.artifacts.shots.length === 7 && p.artifacts.shots.every((s) => s.image.selected?.available && s.voices[0]?.available), '七镜已有图像和配音均可见')
      check(p.progress.issue?.details.length === 1 && p.progress.issue.details[0]?.scopes.length === 2, '相同原始错误去重并保留作用阶段')
      for (const mode of ['i2v', 't2v', 'none']) {
        p = projectCreation(session!, { ...run!, input: JSON.stringify({ recipe: JSON.stringify({ plan: { ...plan, mode: mode === 'none' ? 'slideshow' : 'dynamic' }, videoMode: mode }) }) }, steps, tasks, media)
        check(stage('frames').applicable === (mode === 'i2v') && stage('images').applicable === (mode === 'none') && stage('motion').applicable === (mode !== 'none'), `${mode} 分支适用性来自冻结输入`)
      }
      p = projectCreation({ ...session!, approvedPlan: null }, { ...run!, input: '{bad' }, steps, tasks, media)
      check(p.artifacts.shots.length === 0 && stage('images').applicable === null, '损坏冻结元数据不借用可变会话方案编造成果')
      const recoveredRun = { ...run!, id: run!.id + 100 }
      const recoveredSteps = steps.map((s) => ({ ...s, runId: recoveredRun.id, id: s.id + 100 }))
      tasks = tasks.map((t) => ({ ...t, runId: recoveredRun.id, stepId: t.stepId! + 100 }))
      p = projectCreation(session!, recoveredRun, recoveredSteps, tasks, media)
      check(p.artifacts.shots[0]?.image.selected?.reused === true && p.artifacts.shots[0].image.selected.available, '新 run 显式复用旧素材仍可预览')
      const firstImage = media.find((a) => a.kind === 'image')!
      p = projectCreation(session!, recoveredRun, recoveredSteps, tasks, media.map((a) => a.id === firstImage.id ? { ...a, projectId: projectId + 1 } : a))
      check(p.artifacts.shots[0]?.image.selected?.available === false && p.artifacts.shots[0].image.selected.name === '素材不可用', '跨项目引用不泄露资产元信息')
      p = projectCreation(session!, recoveredRun, recoveredSteps, tasks, media.map((a) => a.id === firstImage.id ? { ...a, params: JSON.stringify({ shotId: 's6' }) } : a))
      check(!p.artifacts.shots[0]?.image.selected?.available, '任务结果与资产镜头关联冲突时不可预览')
      p = projectCreation(session!, recoveredRun, recoveredSteps, tasks, media.map((a) => a.id === firstImage.id ? { ...a, deletedAt: now } : a))
      check(p.artifacts.shots[0]?.image.selected?.available === false, '已删除素材以不可用占位显示')
      p = projectCreation(session!, recoveredRun, recoveredSteps, tasks, media, (a) => a.id !== firstImage.id)
      check(p.artifacts.shots[0]?.image.selected?.available === false, '文件丢失不使详情崩溃')
      p = projectCreation(session!, recoveredRun, recoveredSteps, tasks, [...media, { ...firstImage, id: 9000, runId: 9000 }])
      check(p.artifacts.shots[0]?.image.selected?.assetId === firstImage.id && p.artifacts.shots[0].image.candidates.every((c) => c.assetId === firstImage.id), '不扫描无关项目历史新版本')
      const localTasks = tasks.map((t) => ({ ...t, runId: run!.id, stepId: t.stepId! - 100 }))
      const uncertain = { ...localTasks[0]!, id: 1000, status: 'failed', kind: 'video', attempts: 1, taskId: null, params: '{bad' }
      p = projectCreation(session!, run!, steps, [...localTasks, uncertain, { ...uncertain, id: 1001, taskId: 'external-id' }], media)
      check(p.progress.recovery.requiredTaskIds.join() === '1000' && p.progress.recovery.queryTaskCount === 1 && p.progress.uncertainTasks[0]?.label === '任务 #1000', '无编号核实项与有编号恢复查询分离，未知关联不虚构镜头')
      const finalRel = relPathOf(projectId, 'final_video', 'offline.mp4')
      writeFileSync(absPathOf(finalRel), 'offline-fixture')
      const final = await registerAsset(projectId, { kind: 'video', purpose: 'final_video', name: 'final', runId: run!.id, relPath: finalRel, params: { delivery_checked: true } })
      const later = await registerAsset(projectId, { kind: 'video', purpose: 'final_video', name: 'later', runId: run!.id, relPath: finalRel, params: { delivery_checked: true } })
      await db.update(pipelineRuns).set({ status: 'completed' }).where(eq(pipelineRuns.id, run!.id))
      check((await creationDetail(session!.id)).result?.videoId === later.id, '详情选择最新合格成片')
      p = projectCreation(session!, { ...run!, status: 'completed' }, steps, localTasks, [...media, final, { ...later, relPath: 'missing-file.mp4' }])
      check(p.result === null && p.progress.status === 'failed', '最新合格版本丢失时不悄悄回退旧版')
      await db.update(assets).set({ params: '{}' }).where(eq(assets.id, final.id))
      await db.update(assets).set({ params: '{}' }).where(eq(assets.id, later.id))
      const detail = await creationDetail(session!.id)
      check(detail.result === null && detail.progress?.status === 'failed', '完成 run 无合格成片，详情不得误报成功')
      check((await listCreationSessions()).find((s) => s.id === session!.id)?.runStatus === 'failed', '列表沿用严格交付状态投影')
      check(!JSON.stringify(p).includes('relPath') && !JSON.stringify(p).includes('external-id'), '展示 DTO 不暴露本地路径/完整任务参数/外部编号')
    },
    'first-input': async () => {
      const { db, initDb } = await import('../src/db')
      const { apiConfigs, projects, creationMessages } = await import('../src/db/schema')
      const { eq } = await import('drizzle-orm')
      const { app } = await import('../src/app')
      const { messageSchema } = await import('../src/services/creation-chat/contract')
      await initDb()
      process.env.PROBE_M41_KEY = 'offline-m41-placeholder'
      for (const kind of ['llm', 'audio', 'image', 'video']) await db.delete(apiConfigs).where(eq(apiConfigs.serviceType, kind))
      const now = Date.now()
      await db.insert(apiConfigs).values({ name: 'offline', providerKey: 'deepseek_llm', serviceType: 'llm', apiKeyRef: 'env:PROBE_M41_KEY', baseUrl: 'http://localhost:0/offline', model: 'offline', isActive: 1, isDefault: 1, createdAt: now, updatedAt: now })
      let calls = 0
      let captured = ''
      let content = JSON.stringify({ kind: 'clarify', message: '请补充时长', questions: ['要多长？'] })
      globalThis.fetch = async (url, init) => {
        if (!String(url).startsWith('http://localhost:0/offline')) throw new Error('禁止真实网络')
        calls++; captured = String(init?.body)
        return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } })
      }
      const post = (path: string, data: unknown) => app.request(`/api/v1/creation-sessions${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      const request = { content: '首轮初始文字', requestKey: 'm41-first-draft', deferPlanning: true }
      const firstResponse = await post('', request)
      const first = await firstResponse.json()
      const id = first.session.id
      check(firstResponse.status === 201 && first.session.status === 'draft' && calls === 0 && first.messages.length === 0, '仅创建草稿零模型调用，元数据不显示为已发送消息')
      check(first.session.initialDraft.content === request.content, '初始文字可从服务端安全快照恢复')
      check((await (await post('', request)).json()).session.id === id && calls === 0, '同创建键同输入返回原会话，不重复规划')
      check((await post('', { ...request, content: '不同文字' })).status === 409, '同创建键不同文字返回冲突')
      check((await post('', { ...request, deferPlanning: false })).status === 409, '同创建键不同模式返回冲突')
      check(!messageSchema.safeParse(request).success, '消息 schema 拒绝创建专用字段')
      const upload = async (name: string) => {
        const form = new FormData()
        form.append('file', new File([new Uint8Array([1, 2, 3])], name))
        form.append('role', 'style')
        return app.request(`/api/v1/creation-sessions/${id}/attachments`, { method: 'POST', body: form })
      }
      const uploaded = await upload('reference.png')
      const ref = await uploaded.json()
      check(uploaded.status === 201 && calls === 0, '附件登记零模型调用')
      check((await upload('bad.txt')).status === 422 && calls === 0, '部分上传失败不触发无参考规划')
      const message = { content: '现在生成方案', requestKey: 'm41-first-message', attachments: [ref.assetId, ref.assetId] }
      const planned = await (await post(`/${id}/messages`, message)).json()
      check(calls === 1 && planned.session.status === 'draft' && !planned.session.error, '全部参考就绪后一次规划，追问正常返回')
      check(!captured.includes('initial_draft') && !captured.includes(request.content), '草稿元数据不混入规划上下文')
      await post(`/${id}/messages`, { ...message, attachments: [ref.assetId] })
      check(calls === 1, '消息去重附件指纹稳定，传输重试不重复规划')
      check((await post(`/${id}/messages`, { ...message, attachments: [] })).status === 409 && calls === 1, '同消息键不同附件拒绝且零额外调用')
      check((await post(`/${id}/messages`, { ...message, content: '改文字' })).status === 409, '同消息键不同文字拒绝')
      const second = await post('', { content: '旧文字直达', requestKey: 'm41-legacy-create' })
      check(second.status === 201 && calls === 2, '原文字直达 API 默认仍创建并规划')
      content = 'not-json'
      const failed = await (await post(`/${id}/messages`, { ...message, requestKey: 'm41-failed-message' })).json()
      check(!!failed.session.error && calls === 3, '规划解析失败以详情 error 回传，不误报成功')
      await post(`/${id}/messages`, { ...message, requestKey: 'm41-failed-message' })
      check(calls === 3, '失败请求同键重试不自动再次调用模型')
      const project = (await db.select().from(projects).where(eq(projects.id, first.session.projectId)))[0]!
      check(project.status === 'draft', '规划与附件均不使项目提前转正')
      const messages = await db.select().from(creationMessages).where(eq(creationMessages.sessionId, id))
      check(messages.filter((m) => m.role === 'system').length === 1, '创建重试不回写或重复快照')
      check(planned.messages.some((m: { requestKey?: string }) => m.requestKey === message.requestKey), '详情携带已接收请求键，响应丢失后可先核对')
    },
    'first-input-client': async () => {
      const { createFirstInput } = await import('../../web/src/views/easy-create/use-first-input')
      type Detail = import('../../web/src/lib/types/creation-chat').CreationDetail
      type Item = import('../../web/src/views/easy-create/use-creation-chat').AttachmentItem
      const data = new Map<string, string>()
      const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
      const host = { currentId: 0, attachments: [] as Item[], error: '', notice: '' }
      let detail = { session: { id: 1, status: 'draft', plan: null, runId: null, error: null, initialDraft: { content: '初始文字', requestKey: 'client-create-key' } }, messages: [], artifacts: { shots: [], documents: [] }, progress: null, result: null } as unknown as Detail
      let creates = 0, sends = 0, uploads = 0, reads = 0
      let failUpload = '', loseCreate = false, loseSend = false, clarify = false, failPlan = false, failRead = false
      let waitRead: Promise<Detail> | null = null
      let createKey = '', sendKey = ''
      const copy = () => structuredClone(detail)
      const api = {
        create: async (content: string, key: string, deferred?: boolean) => {
          creates++; createKey ||= key
          check(deferred === true && key === createKey, '客户端创建只使用草稿模式与固定创建键')
          detail.session.initialDraft = { content, requestKey: key }
          if (loseCreate) { loseCreate = false; throw new Error('创建响应丢失') }
          return copy()
        },
        detail: async () => { reads++; if (failRead) throw new Error('断网'); return waitRead ?? copy() },
        send: async (_id: number, content: string, key: string, attachments?: number[]) => {
          sends++; sendKey = key
          detail.messages.push({ id: sends + 100, role: 'user', content, requestKey: key, createdAt: 0, payload: { kind: 'input', attachments: [...(attachments ?? [])] } })
          if (failPlan) detail.session.error = '模型失败'
          else if (clarify) detail.messages.push({ id: sends + 200, role: 'assistant', content: '请补充', requestKey: null, createdAt: 0, payload: { kind: 'clarify', questions: ['多长？'] } })
          else detail.session.plan = { title: '离线方案' } as Detail['session']['plan']
          if (loseSend) throw new Error('发送响应丢失')
          return copy()
        },
      }
      const hooks = { commit: () => {}, polling: () => {}, upload: async (item: Item) => {
        uploads++
        if (item.name === failUpload) { item.error = '上传失败'; return }
        item.assetId = uploads; item.hash = `hash-${uploads}`; item.error = undefined
        detail.messages.push({ id: uploads, role: 'user', content: '', requestKey: null, createdAt: 0, payload: { kind: 'attachment', ref: { assetId: item.assetId, hash: item.hash, kind: item.kind, role: item.role } } })
      } }
      const make = () => createFirstInput(host, hooks, api, () => storage)
      let first = make()
      const item = (name: string): Item => ({ clientId: name, name, kind: 'image', role: 'style', uploading: false, sourceAssetId: 100 })
      host.attachments = [item('成功项'), item('失败项')]
      loseCreate = true
      check(await first.start('初始文字') === null && sends === 0 && uploads === 0, '创建结果不明不上传或收费规划')
      check(await first.start('试图改变文字') === 1 && creates === 2 && detail.session.initialDraft?.content === '初始文字', '创建响应丢失后重用原始快照')
      first.activate(copy())
      check(host.attachments.length === 2, '同会话初始化不清空移交托盘')
      failUpload = '失败项'
      check(!await first.submit('初始文字') && sends === 0 && uploads === 2 && first.state.phase === 'paused', '部分上传失败暂停，未发出无参考规划')
      host.attachments.splice(1, 1)
      clarify = true
      check(await first.submit('初始文字') && sends === 1 && uploads === 2 && host.attachments.length === 1, '移除失败项后继续，成功项不重传，追问保留参考')
      check(first.state.phase === 'clarify' && first.state.ticket?.content === '', '追问清首轮文字并等待用户回答')
      failRead = true
      check(!await first.submit('30秒') && sends === 1, '回读失败不发送新的收费请求')
      failRead = false; clarify = false; failPlan = true
      check(!await first.submit('30秒') && sends === 2 && first.state.phase === 'failed' && host.attachments.length === 1, 'HTTP 200 规划错误仍保留文字和参考')
      const failedKey = sendKey
      check(!await first.submit('30秒') && sends === 2, '普通继续不会自动重新调用失败的模型')
      failPlan = false; detail.session.error = null; loseSend = true
      // 重新规划前服务端仍保留失败状态；回读后由本次发送清除。
      detail.session.error = '模型失败'
      const realSend = api.send
      api.send = async (...args: Parameters<typeof realSend>) => { detail.session.error = null; return realSend(...args) }
      check(!await first.submit('30秒', true) && sends === 3 && sendKey !== failedKey, '明确重新规划才创建新的请求键，响应丢失保留票据')
      loseSend = false
      check(await first.submit('30秒') && sends === 3 && !first.state.ticket && host.attachments.length === 0 && !data.has('ec-first-input:1'), '回读确认已完成后清理草稿，不重复规划')
      detail = { ...detail, session: { ...detail.session, id: 2, plan: null, error: null }, messages: [] }
      host.currentId = 2; host.attachments = []
      first.activate(copy())
      host.attachments = [{ ...item('未上传.png'), sourceAssetId: undefined, file: new File(['bytes'], '未上传.png'), thumbUrl: 'blob:forbidden' }]
      first.save()
      const saved = data.get('ec-first-input:2')!
      check(!saved.includes('blob:') && !saved.includes('bytes') && !saved.includes('"file"'), '本地存储不含文件字节或对象 URL')
      first.detach(); first = make(); first.activate(copy())
      check(host.attachments[0]?.error?.includes('重新选择') && first.state.phase === 'paused' && sends === 3, '刷新只恢复草稿，未上传文件明确要求重新选择')
      let resolveRead!: (value: Detail) => void
      waitRead = new Promise((resolve) => { resolveRead = resolve })
      const pending = first.submit('继续')
      first.pause(); host.currentId = 3; host.attachments = []
      resolveRead(copy()); await pending; waitRead = null
      check(sends === 3 && host.currentId === 3 && host.attachments.length === 0, '切会话后晚到回读不上传、不规划、不污染新会话')
      check(reads >= 7, '所有客户端重试先核对会话')
    },
  } })
}
void main()
