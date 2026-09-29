/**
 * 正版曲库入库规范探针（阶段一：bgm-library 侧车解析 + smart-bgm.importLibraryTrack 落 tags/params）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-bgm-library.ts [--section=pure|live]
 *
 * 隔离策略：isolatedEnv('bgmlib') 一次性临时目录（独立 studio.db + workspace），必须先于任何 src 动态 import。
 * live 节设 MONTAGE_BGM_DIR 为临时曲库目录，写入伪 mp3 + 同名侧车，经 resolveAutoBgm 触发 importLibraryTrack，
 * 断言侧车字段落 tags/params、缺侧车向后兼容、文件名正则兜底、授权溯源可见、幂等哈希，以及红线：
 * 情绪向量落 params.moodEmbedding（模型就绪时）而 assets.embedding 列恒 null（防污染文本召回）。零网络（禁网桩）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('bgmlib')

const SECTIONS = ['pure', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-bgm-library')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log,
  title: 'BGM-LIBRARY',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成（零真实执行）')
  },
  runners: {
    // ================= pure：词表 + 侧车/文件名解析（零 fs/DB/模型） =================
    pure: async () => {
      const lib = await import('../src/services/bgm-library')
      const { BGM_MOODS, BGM_STYLES, BGM_STEMS, canonicalizeMood, parseBgmSidecarJson, metaFromFilename, bgmSidecarPath, buildTrackMoodText, hasLicense } = lib

      // —— 词表常量 ——
      check(BGM_MOODS.includes('紧张') && BGM_MOODS.length === 10, '情绪枚举齐全（含紧张，10 项）')
      check(BGM_STYLES.includes('钢琴') && (BGM_STEMS as readonly string[]).includes('instrumental'), '风格/分轨枚举含预期成员')

      // —— canonicalizeMood：枚举命中 / 同义词映射 / 未命中 null ——
      check(canonicalizeMood('紧张') === '紧张', '情绪词命中枚举原样返回')
      check(canonicalizeMood('急迫') === '紧张' && canonicalizeMood('tense') === '紧张', '同义词（中/英）归一到枚举')
      check(canonicalizeMood('从未收录词') === null && canonicalizeMood('') === null, '未命中/空 → null')

      // —— parseBgmSidecarJson：完整侧车 ——
      const full = parseBgmSidecarJson(JSON.stringify({ mood: '紧张,反转', style: ['电子'], stems: 'instrumental', bpm: 90, desc: '追逐戏', license: { source: '曲多多', order_id: 'o-1', scope: 'commercial', expires: '2030-01-01' } }))
      check(!!full && JSON.stringify(full.mood) === JSON.stringify(['紧张', '反转']) && JSON.stringify(full.style) === JSON.stringify(['电子']), '完整侧车：mood 多值归一 + style 数组')
      check(full!.stems === 'instrumental' && full!.bpm === 90 && full!.license?.source === '曲多多' && full!.license?.order_id === 'o-1', '完整侧车：stems/bpm/license 溯源落位')
      // 非枚举情绪保留在 raw_moods、被过滤出 mood
      const partial = parseBgmSidecarJson(JSON.stringify({ mood: '紧张,抽象蓝' }))
      check(partial!.mood.join(',') === '紧张' && partial!.raw_moods.includes('抽象蓝'), '非枚举情绪原样入 raw_moods、mood 仅收枚举')
      // 空壳/非法 → null
      check(parseBgmSidecarJson('{}') === null, '空壳侧车 → null（视作无）')
      check(parseBgmSidecarJson('not json') === null && parseBgmSidecarJson('') === null && parseBgmSidecarJson(null) === null, '非法/空侧车 → null（回退文件名兜底）')
      // 非法 stems → null 字段但整体仍有效（有 mood 信号）
      const badStem = parseBgmSidecarJson(JSON.stringify({ mood: '温情', stems: 'drums' }))
      check(badStem!.stems === null && badStem!.mood.join(',') === '温情', '非法 stems 归 null 不影响其余字段')

      // —— metaFromFilename：文件名内联提示兜底 ——
      const fn = metaFromFilename('bgm-01[mood=紧张,反转|style=电子].mp3')
      check(!!fn && JSON.stringify(fn.mood) === JSON.stringify(['紧张', '反转']) && fn.style.join(',') === '电子', '文件名 [mood=..|style=..] 正则兜底解析')
      check(metaFromFilename('no-here.mp3') === null && metaFromFilename('track[notes=x].mp3') === null, '无内联提示/无 mood|style 段 → null')

      // —— bgmSidecarPath ——
      check(bgmSidecarPath(join('a', 'b', 'track.mp3')) === join('a', 'b', 'track.bgm.json'), '侧车路径 = 同名同目录 *.bgm.json')

      // —— buildTrackMoodText（embedding 输入文本） ——
      const txt = buildTrackMoodText(full)
      check(!!txt && txt!.includes('紧张') && txt!.includes('电子') && txt!.includes('情绪'), 'moodText 汇情绪+风格+desc')
      check(buildTrackMoodText(null) === null, '无 meta → moodText null')
      check(buildTrackMoodText({ mood: [], raw_moods: [], style: [], raw_styles: [], stems: null, bpm: null, desc: '仅有描述', license: null }) === '仅有描述', '无情绪/风格但含 desc → desc 文本')

      // —— hasLicense ——
      check(hasLicense(full) === true && hasLicense(null) === false, 'license.source 存在与否决定授权溯源可见')
      check(hasLicense({ mood: [], raw_moods: [], style: [], raw_styles: [], stems: null, bpm: null, desc: null, license: { source: '', order_id: null, scope: null, expires: null } }) === false, 'license.source 空串视为无溯源')
    },

    // ================= live：importLibraryTrack 落库（经 resolveAutoBgm 触发，零网络） =================
    live: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, assets } = await import('../src/db/schema')
      const { eq, and, isNull } = await import('drizzle-orm')
      const { ensureProjectDirs } = await import('../src/services/storage')
      const { resolveAutoBgm } = await import('../src/services/smart-bgm')
      const { readBgmMeta } = await import('../src/services/bgm-library')
      const { embeddingStatus } = await import('../src/services/embedding')

      // 禁网桩：入库/选曲链绝不经外网（embedding 未就绪时 computeMoodEmbedding 直接返回 null）
      const fetchBak = globalThis.fetch
      globalThis.fetch = (async () => { throw new Error('BGM 入库链禁网（零付费红线）') }) as typeof fetch
      try {
        // 临时曲库目录 + MONTAGE_BGM_DIR
        const libDir = mkdtempSync(join(tmpdir(), 'acs-bgmlib-dir-'))
        const writeTrack = (fileName: string, sidecar?: string): string => {
          const abs = join(libDir, fileName)
          writeFileSync(abs, Buffer.from([0x49, 0x44, 0x33, 0x00])) // 伪 mp3 头（时长探测失败 → null，宽容）
          if (sidecar) writeFileSync(abs.replace(/\.mp3$/, '.bgm.json'), sidecar, 'utf8')
          return abs
        }
        writeTrack('tense.mp3', JSON.stringify({ mood: '紧张', style: ['管弦'], stems: 'instrumental', license: { source: '曲多多', order_id: 'o-9', scope: 'commercial' } }))
        writeTrack('plain.mp3') // 无侧车无提示 → 纯时长候选（向后兼容）
        // 文件名内联提示兜底（无侧车文件）：Windows 文件名禁用 `|`，用无管道形式仍触发 metaFromFilename 的 mood= 解析
        writeFileSync(join(libDir, 'epic[mood=燃].mp3'), Buffer.from([0x49, 0x44, 0x33]))
        process.env.MONTAGE_BGM_DIR = libDir

        // 项目 + run
        const now = Date.now()
        const [proj] = await db.insert(projects).values({ name: 'bgmlib-live', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: now, updatedAt: now }).returning()
        const pid = proj!.id
        ensureProjectDirs(pid)
        const [run] = await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'photo-montage', templateSnapshot: '{}', status: 'running', input: '{}', createdAt: now, updatedAt: now } as never).returning()
        const ctx = { run: { id: run!.id, projectId: pid }, log: () => {} } as never

        await resolveAutoBgm(ctx, 20)

        const findByName = async (name: string) => (await db.select().from(assets).where(and(eq(assets.projectId, pid), eq(assets.name, name))))[0]
        const tense = await findByName('tense.mp3')
        const plain = await findByName('plain.mp3')
        const epic = await findByName('epic[mood=燃].mp3')

        // —— 侧车字段落 tags/params ——
        check(!!tense, '带侧车曲已入库（copyFileSync + registerAsset）')
        const tenseTags = JSON.parse(tense!.tags ?? '[]') as string[]
        check(tenseTags.includes('bgm_library') && tenseTags.includes('紧张') && tenseTags.includes('管弦'), 'tags：bgm_library + 情绪 + 风格')
        const tp = JSON.parse(tense!.params ?? '{}') as Record<string, any>
        check(JSON.stringify(tp.mood) === JSON.stringify(['紧张']) && tp.stems === 'instrumental' && tp.license?.source === '曲多多', 'params：mood/stems/license 溯源落位')
        check(tp.has_license === true && typeof tp.bgm_sidecar_hash === 'string' && tp.bgm_sidecar_hash.length === 16, 'params：has_license 可见 + 侧车哈希（幂等重算锚点）')

        // —— 缺侧车向后兼容 ——
        const pp = JSON.parse(plain!.params ?? '{}') as Record<string, any>
        check(JSON.parse(plain!.tags ?? '[]').join(',') === 'bgm_library', '无侧车无提示：tags 仅 bgm_library（纯时长候选）')
        check(pp.mood === null && pp.has_license === false && pp.bgm_sidecar_hash === null, '无侧车：mood null / 无溯源 / 无哈希（逐字节兼容现网）')

        // —— 文件名正则兜底 ——
        const ep = JSON.parse(epic!.params ?? '{}') as Record<string, any>
        check(JSON.stringify(ep.mood) === JSON.stringify(['燃']) && ep.bgm_sidecar_hash === null, '文件名内联提示兜底解析（无侧车哈希）')

        // —— 红线：情绪向量落 params，不污染 assets.embedding 列 ——
        const embReady = (await embeddingStatus()).ready
        check(tense!.embedding === null && plain!.embedding === null && epic!.embedding === null, '红线：所有入库曲 assets.embedding 列恒 null（防污染文本召回）')
        if (embReady) {
          check(Array.isArray(tp.moodEmbedding) && tp.moodEmbedding.every((x: unknown) => typeof x === 'number') && typeof tp.moodEmbeddingModel === 'string', '模型就绪：情绪向量落 params.moodEmbedding + model@dims 标识')
        } else {
          check(tp.moodEmbedding === undefined, '模型未就绪：不写 moodEmbedding（退化纯时长候选，不断链）')
        }

        // —— 绑定不变量：本 run 有效 bgm 行 ≤1 ——
        const bound = (await db.select().from(assets).where(and(eq(assets.runId, run!.id), eq(assets.purpose, 'bgm'), isNull(assets.deletedAt))))
        check(bound.length <= 1, `每 run 有效 bgm 行至多 1 条（实际 ${bound.length}）`)

        // —— readBgmMeta 幂等哈希：同内容同哈希，改侧车哈希变 ——
        const absTense = join(libDir, 'tense.mp3')
        const h1 = readBgmMeta(absTense, 'tense.mp3').sidecarHash
        const h1b = readBgmMeta(absTense, 'tense.mp3').sidecarHash
        writeFileSync(join(libDir, 'tense.bgm.json'), JSON.stringify({ mood: '悬疑' }), 'utf8')
        const h2 = readBgmMeta(absTense, 'tense.mp3').sidecarHash
        check(h1 === h1b && h1.length === 16, '幂等：同侧车内容 → 同哈希')
        check(h2 !== h1, '侧车变更 → 哈希变化（触发 embedding 重算）')
        check(readBgmMeta(join(libDir, 'plain.mp3'), 'plain.mp3').sidecarHash === '', '无侧车文件 → 哈希空串')
      } finally {
        globalThis.fetch = fetchBak
        delete process.env.MONTAGE_BGM_DIR
      }
    },
  },
})
