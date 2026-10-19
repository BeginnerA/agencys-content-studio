/**
 * 轻松创作 Agent 真机意图冒烟（opt-in，手动执行）——收口 M63/M64/M65 遗留的验证盲区：
 *   既有探针只做「打桩 engine.startRun + 手工构造合法/非法 JSON」，验证的是「三形契约能否解析」，
 *   从未用真实 LLM 端点跑真实用户输入。用户实弹「把这些图片剪辑成一个视频」失败正是这个盲区漏出的。
 *   本脚本补上真机面：真实模型 × 代表性需求矩阵，观察它是否稳定产出合规决策（尤其上传原图 → route photo-montage），
 *   以及非反推的解析失败是否已回落为「优雅 clarify 追问」而非死胡同红字。
 *
 * ⚠ 真机代价与副作用（因此默认拒绝执行）：
 *   - 会真实调用文本/多模态模型，产生 LLM 计费；
 *   - 会读写你正在使用的 studio.db（新建临时项目/会话/素材，脚本结束时软删清理，不污染列表）。
 *   所以必须显式加 --yes 才真正发起；不加仅打印将要执行的需求矩阵与前置检查后退出——可安全放进任何环境、零成本、不进 run-probes / CI。
 *
 * 运行：cd apps/server && npx tsx scripts/smoke-agent-intents.ts --yes
 *   前置：AI 配置里须启用 chat（规划）实例（模型/端点/密钥），否则脚本会在计费前明确拒绝。
 * 退出码：0 = 冒烟跑完（真机结果不确定，脚本如实分类汇报，不硬断言）；1 = 前置不满足（未跑成，无计费）。
 */
import { db, initDb } from '../src/db'
import { assets, creationSessions, projects } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { agentModeEnabled } from '../src/services/creation-chat/agent-run'
import { sendCreationMessage } from '../src/services/creation-chat/planning'
import { sessionRow } from '../src/services/creation-chat/store'
import { requiredEndpoint } from '../src/services/creation-chat/preflight'
import type { CreationError as CreationErrorType } from '../src/services/creation-chat/contract'

/** 代表性需求矩阵：覆盖上传原图拼片（用户实弹句 + 强混剪词）、纯文本生成、含糊诉求。imageAssets>0 的用例会真塞图片素材进会话。 */
const INTENTS: Array<{ text: string; imageAssets: number; expectMontage?: boolean }> = [
  { text: '将这些图片剪辑成一个视频', imageAssets: 5, expectMontage: true },
  { text: '把这些照片拼成一个电子相册', imageAssets: 3, expectMontage: true },
  { text: '帮我做一条讲春天来了的科普短视频，配旁白和字幕', imageAssets: 0 },
  { text: '随便来点有意思的', imageAssets: 0 },
]

const FAKE_SHA = '0'.repeat(63) + '1'

/** 建一次性 draft 项目 + agent 会话（agentMode 强制 1，绕过 env 门控以真测 agent 路径） */
async function seedSession(tag: string): Promise<{ projectId: number; sessionId: number }> {
  const t = Date.now()
  const [project] = await db.insert(projects).values({
    name: `〔真机冒烟〕${tag}`.slice(0, 40), genre: 'other', templateKey: 'quick-video', status: 'draft',
    brief: tag, tags: JSON.stringify(['真机冒烟']), createdAt: t, updatedAt: t,
  }).returning()
  const projectId = project!.id
  const key = `smoke${t}${Math.random().toString(36).slice(2, 8)}`
  const [session] = await db.insert(creationSessions).values({
    projectId, requestKey: key, status: 'draft', agentMode: 1, planRevision: 0, runHistory: '[]', createdAt: t, updatedAt: t,
  }).returning()
  return { projectId, sessionId: session!.id }
}

/** 塞 N 张 image 素材（无真实字节：vision 读取失败会被现行 try/catch 安全跳过，仍保留 assetId 供路由指令引用） */
async function seedImages(projectId: number, n: number): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < n; i += 1) {
    const t = Date.now()
    const [a] = await db.insert(assets).values({
      projectId, kind: 'image', name: `冒烟素材_${i + 1}.png`, mime: 'image/png', ext: 'png',
      sha256: FAKE_SHA, tags: '[]', isFavorite: 0, createdAt: t, updatedAt: t,
    }).returning()
    ids.push(a!.id)
  }
  return ids
}

/** 软删清理：给项目打 deletedAt，关联会话一并（列表与后续查询都按 isNull(deletedAt) 过滤） */
async function cleanup(projectId: number): Promise<void> {
  const t = Date.now()
  await db.update(projects).set({ deletedAt: t, updatedAt: t }).where(eq(projects.id, projectId))
}

function errorCode(err: unknown): string {
  const e = err as CreationErrorType
  return e && typeof e.code === 'string' ? e.code : 'other'
}

async function runOne(intent: (typeof INTENTS)[number]): Promise<void> {
  const { projectId, sessionId } = await seedSession(intent.text.slice(0, 24))
  const assetIds = intent.imageAssets ? await seedImages(projectId, intent.imageAssets) : []
  console.log(`\n──── 需求：「${intent.text}」${assetIds.length ? `（+${assetIds.length} 张上传图）` : ''}`)
  const startedAt = Date.now()
  let outcome = ''
  try {
    await sendCreationMessage(sessionId, { content: intent.text, requestKey: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`, attachments: assetIds })
    const s = await sessionRow(sessionId)
    if (s.status === 'ready' && s.decision) {
      const decision = JSON.parse(s.decision) as { kind?: string; mode?: string }
      const routedMontage = JSON.stringify(decision).includes('photo-montage')
      const mode = decision.mode ?? decision.kind ?? '未知'
      if (intent.expectMontage) {
        outcome = routedMontage ? '✔ route → photo-montage（真机正确命中上传素材拼片配方）' : `⚠ 已产出决策（mode=${mode}）但未 route 到 photo-montage——模型未采纳路由指令，需回看提示词/nudge`
      } else {
        outcome = `✔ 产出合规决策（mode=${mode}），非死胡同`
      }
    } else if (s.status === 'draft' && !s.error) {
      outcome = '◻ 回落 draft·无错误（大概率解析失败已优雅兜底为 clarify 追问，见会话消息——不再是 invalid_plan 红字）'
      if (intent.expectMontage) outcome += '；⚠ 但未 route 成 photo-montage，真机模型仍需引导'
    } else {
      outcome = `？ 会话态=${s.status}${s.error ? ` / error=${s.error}` : ''}（请人工判读）`
    }
  } catch (err) {
    outcome = `✘ 抛出异常 code=${errorCode(err)}：${err instanceof Error ? err.message : String(err)}`
  }
  console.log(`  → ${outcome}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
  await cleanup(projectId)
}

async function main(): Promise<void> {
  const agreed = process.argv.slice(2).includes('--yes')
  console.log('=== 轻松创作 Agent 真机意图冒烟 ===')
  console.log('将逐条以真实 LLM 规划以下需求：')
  for (const it of INTENTS) console.log(`  · 「${it.text}」${it.imageAssets ? ` (上传 ${it.imageAssets} 图)` : ''}${it.expectMontage ? ' [期望 route photo-montage]' : ''}`)
  if (!agreed) {
    console.log('\n（试运行：未加 --yes，不发起任何真实模型调用、不写库。真正执行请加： npx tsx scripts/smoke-agent-intents.ts --yes）')
    return
  }

  await initDb()
  if (!agentModeEnabled()) {
    console.error('\n✘ 前置不满足：CREATION_AGENT_MODE 被显式关闭，将走 legacy 路径测不到 agent 决策。请取消该环境变量后重试（未产生费用）。')
    process.exitCode = 1
    return
  }
  try {
    await requiredEndpoint('llm')
  } catch {
    console.error('\n✘ 前置不满足：未配置可用的 chat（规划）模型实例。请在 AI 配置中启用并填写模型/端点/密钥后重试（未产生费用）。')
    process.exitCode = 1
    return
  }
  console.log('\n前置就绪，开始真机调用（将产生 LLM 计费）……')
  for (const it of INTENTS) {
    try { await runOne(it) } catch (err) { console.error(`  用例执行异常（已跳过，继续下一条）：${err instanceof Error ? err.message : String(err)}`) }
  }
  console.log('\n=== 冒烟结束（临时项目已软删清理）。真机结果非确定，重复跑数次观察命中率更能说明问题。===')
}

void main().catch((err) => { console.error('冒烟脚本致命错误：', err); process.exitCode = 1 })
