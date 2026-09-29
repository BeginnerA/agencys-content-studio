/**
 * BGM 情绪选曲探针（阶段二：bgm-mood 聚合 + montage.pickBgm 情绪层，含零 diff 显式断言）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-bgm-mood.ts [--section=pure|live]
 *
 * 隔离策略：isolatedEnv('bgmmood') 一次性临时目录（独立 studio.db + workspace），必须先于任何 src 动态 import。
 * pure 节：aggregateMoodTokens/baseToneWord 频率聚合 + pickBgm 情绪 cosine 分层 + 零 diff（moodVec 空/全体候选无向量
 *   → 逐字节 = 旧时长+时效序）；live 节：aggregateRunMood 从台词 emotionHint 聚合文本（无模型 → vec null 不断链），
 *   以及端到端注入情绪向量使 resolveAutoBgm 选中「情绪贴合曲」（绕开模型依赖，证明接线消费情绪）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { writeFileSync } from 'node:fs'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import type { BgmCandidate } from '../src/pipeline/actions/ffmpeg-merge/montage'

const { cleanup } = isolatedEnv('bgmmood')

const SECTIONS = ['pure', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-bgm-mood')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log,
  title: 'BGM-MOOD',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成（零真实执行）')
  },
  runners: {
    // ================= pure：情绪聚合 + pickBgm 情绪分层 + 零 diff =================
    pure: async () => {
      const { baseToneWord, aggregateMoodTokens } = await import('../src/services/bgm-mood')
      const { pickBgm } = await import('../src/pipeline/actions/ffmpeg-merge/montage')

      // —— baseToneWord ——
      check(baseToneWord('紧张——心跳加速，低音铺陈') === '紧张', 'emotion_hint 取破折号前基调词')
      check(baseToneWord('温情') === '温情' && baseToneWord('') === '', '无破折号取全串 / 空 → 空')

      // —— aggregateMoodTokens：频次降序 + 同义归一 + 无信号 null ——
      const agg = aggregateMoodTokens(['紧张——a', '紧张——b', '温情——c', '急迫——d'])
      check(JSON.stringify(agg.moods) === JSON.stringify(['紧张', '温情']), '按频次降序聚合（急迫→紧张计入紧张=3）')
      check(agg.counts['紧张'] === 3 && agg.counts['温情'] === 1, '同义词归一后计数正确')
      check(agg.text === '紧张、温情 情绪', '聚合情绪文本')
      check(aggregateMoodTokens(['从未收录']).text === null && aggregateMoodTokens([]).moods.length === 0, '无枚举命中/空输入 → text null（退化纯时长）')

      // —— pickBgm 情绪分层 ——
      const cand = (id: number, d: number | null, upd: number, moodVec?: number[]): BgmCandidate => ({ id, path: `p${id}`, durationSec: d, updatedAt: upd, moodVec: moodVec ?? null })
      // 达标集内情绪高者胜（两者时长均 ≥ 片长，情绪向量贴合者先）
      const near = cand(1, 30, 100, [1, 0])
      const far = cand(2, 22, 200, [0, 1])
      check(pickBgm([far, near], 20, { moodVec: [1, 0] })!.id === 1, '可行集内情绪 cosine 高者胜出（时长达标前提下）')
      // 情绪相同 → 回落片长差
      const sameA = cand(1, 30, 100, [1, 0])
      const sameB = cand(2, 22, 200, [1, 0])
      check(pickBgm([sameA, sameB], 20, { moodVec: [1, 0] })!.id === 2, '情绪同分 → 回落与片长差最小（22s 胜 30s）')
      // 时长硬约束优先于情绪：不达标的高情绪曲输给达标的低情绪曲
      const shortHot = cand(1, 8, 100, [1, 0])
      const longCold = cand(2, 30, 50, [0, 1])
      check(pickBgm([shortHot, longCold], 20, { moodVec: [1, 0] })!.id === 2, '时长达标为硬约束：不足片长的高情绪曲不越级')
      // 部分候选无向量：有向量者先于纯时长候选（同达标档内）
      const withVec = cand(1, 30, 100, [1, 0])
      const noVec = cand(2, 25, 200, undefined)
      check(pickBgm([noVec, withVec], 20, { moodVec: [1, 0] })!.id === 1, '同达标档内有情绪向量者先于无向量候选')

      // —— 零 diff 显式断言 ——
      // 情形一：opts.moodVec 为空（未传）→ 排序逐字节 = 旧版（时长+时效）
      const legacy = [cand(1, 30, 100), cand(2, 30, 200)]
      const withNullOpt = pickBgm(legacy, 20, { moodVec: null })!.id
      const withNoOpt = pickBgm(legacy, 20)!.id
      const oldExpected = 2 // 双 30s 同达标同差 → updatedAt desc → id2(200)
      check(withNullOpt === oldExpected && withNoOpt === oldExpected, 'moodVec 为空 → 逐字节 = 旧序（同长 tie → updatedAt desc）')
      // 情形二：全体候选 moodVec=null 但 run 传了情绪向量 → cosSim 恒 null → 情绪比较恒 0 → 旧序
      const allNoVec = [cand(1, 30, 100, undefined), cand(2, 22, 200, undefined)]
      const runVec = [1, 0]
      check(pickBgm(allNoVec, 20, { moodVec: runVec })!.id === pickBgm(allNoVec, 20)!.id, '全体候选无向量 + 有 run 情绪 → 与无情绪排序一致（零 diff）')
      // 探测失败者仍排最后（null 时长），不受情绪层影响
      check(pickBgm([cand(1, null, 999, [1, 0]), cand(2, 15, 1, [0, 1])], 10, { moodVec: [1, 0] })!.id === 2, '时长探测失败候选仍排最后（情绪层不改硬约束底线）')
    },

    // ================= live：aggregateRunMood 接线 + 端到端情绪选曲（注入向量绕开模型） =================
    live: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, assets } = await import('../src/db/schema')
      const { eq, and, isNull } = await import('drizzle-orm')
      const { ensureProjectDirs, registerAsset, relPathOf, absPathOf } = await import('../src/services/storage')
      const { aggregateRunMood } = await import('../src/services/bgm-mood')
      const { resolveAutoBgm } = await import('../src/services/smart-bgm')

      const fetchBak = globalThis.fetch
      globalThis.fetch = (async () => { throw new Error('情绪选曲链禁网（零付费红线）') }) as typeof fetch
      try {
        const now = Date.now()
        const [proj] = await db.insert(projects).values({ name: 'bgmmood-live', genre: 'other', templateKey: 'mengbao-episode', status: 'active', settings: '{}', tags: '[]', createdAt: now, updatedAt: now }).returning()
        const pid = proj!.id
        ensureProjectDirs(pid)
        const newRun = async () => (await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'mengbao-episode', templateSnapshot: '{}', status: 'running', input: '{}', createdAt: Date.now(), updatedAt: Date.now() } as never).returning())[0]!
        const mkAudioFile = async (name: string, params: Record<string, unknown>, duration: number) => {
          const rel = relPathOf(pid, 'audio', name)
          writeFileSync(absPathOf(rel), Buffer.from([0x49, 0x44, 0x33]))
          return registerAsset(pid, { name, kind: 'audio', purpose: 'source', relPath: rel, ext: 'mp3', mime: 'audio/mpeg', duration, params })
        }

        // —— aggregateRunMood：从 run 内音频资产 emotionHint 聚合主导情绪文本 ——
        const runM = await newRun()
        await registerAsset(pid, { name: 'vo-1.mp3', kind: 'audio', purpose: 'voice', relPath: relPathOf(pid, 'audio', 'vo-1.mp3'), runId: runM.id, params: { emotionHint: '紧张——心跳加速' } })
        await registerAsset(pid, { name: 'vo-2.mp3', kind: 'audio', purpose: 'voice', relPath: relPathOf(pid, 'audio', 'vo-2.mp3'), runId: runM.id, params: { emotionHint: '紧张——低音铺陈' } })
        await registerAsset(pid, { name: 'vo-3.mp3', kind: 'audio', purpose: 'voice', relPath: relPathOf(pid, 'audio', 'vo-3.mp3'), runId: runM.id, params: { emotionHint: '温情——钢琴独奏' } })
        const mood = await aggregateRunMood({ run: { id: runM.id, projectId: pid }, log: () => {} } as never)
        check(mood.text === '紧张、温情 情绪', `台词 emotionHint 聚合主导情绪文本（实际 ${mood.text}）`)
        // 模型未就绪 → vec null（不断链）；就绪 → number[]（两态均不抛错即达红线）
        check(mood.vec === null || (Array.isArray(mood.vec) && mood.vec.every((x) => typeof x === 'number')), '情绪向量：模型缺失 → vec null 不断链 / 就绪 → number[]')

        // —— 端到端：注入候选情绪向量 + run 情绪向量，resolveAutoBgm 选中贴合曲（绕开模型） ——
        const runSel = await newRun()
        const tense = await mkAudioFile('sel-tense.mp3', { moodEmbedding: [1, 0] }, 30)
        await mkAudioFile('sel-warm.mp3', { moodEmbedding: [0, 1] }, 30)
        const picked = await resolveAutoBgm({ run: { id: runSel.id, projectId: pid }, log: () => {} } as never, 20, { text: '紧张 情绪', vec: [1, 0] })
        check(!!picked && picked.asset.id === tense.id, `情绪贴合驱动选曲：紧张 run 命中「紧张」向量曲（实际 ${picked?.asset.name}）`)
        const bound = (await db.select().from(assets).where(and(eq(assets.runId, runSel.id), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt))))
        check(bound.length === 1, `选中后绑定本 run 有效 bgm 行恰 1 条（1 bgm/run 不变量，实际 ${bound.length}）`)

        // —— 零 diff 端到端：run 情绪 vec=null（无模型/无情绪）→ 退回时长+updatedAt（与注入情绪前不同选择）——
        const runTie = await newRun()
        const t2 = await mkAudioFile('tie-200.mp3', {}, 30) // 先建（updatedAt 较小）
        await new Promise((r) => setTimeout(r, 2))
        const t3 = await mkAudioFile('tie-300.mp3', {}, 30) // 后建（updatedAt 较大）
        const noMood = await resolveAutoBgm({ run: { id: runTie.id, projectId: pid }, log: () => {} } as never, 20, { text: null, vec: null })
        // 两支 30s 同达标、无情绪 → updatedAt desc → 后建的 tie-300
        check(!!noMood && (noMood.asset.id === t3.id || noMood.asset.id === t2.id), '无情绪向量 → 退回时长+时效纯时长规则选中（不断链）')
        check(!!noMood && noMood.asset.name === 'tie-300.mp3', '零 diff：同长无情绪 tie → updatedAt desc 命中后建曲')
      } finally {
        globalThis.fetch = fetchBak
      }
    },
  },
})
