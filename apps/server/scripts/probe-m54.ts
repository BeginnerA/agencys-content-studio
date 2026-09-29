/**
 * M54 探针（智能混剪增强：kb:auto / 构图锚点 / collage 拼贴 / 智能 BGM）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m54.ts [--section=pure|args|template|live]
 *
 * 隔离策略：isolatedEnv('m54', bridge templates) 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。live 节素材本地 ffmpeg 生成（color/sine）；music_gen 走
 * globalThis.fetch 桩契约测试（零真实付费），并断言失败降级库内 auto 与 usage kind='music' 口径。
 *
 * 断言面（docs/montage-ai-spec.md §7）：
 *  - pure：kbDirectionFor auto 三态 + 既有模式零 diff / classifyAnchor / kbAnchorFor / voteSubject /
 *    montageEnabled 对 auto 触发 / planCollageSegments 四种 layout / pickBgm 规则 / scanBgmLibrary；
 *  - args：buildNormalizeArgs collage 分支（duo vstack、grid xstack、tile 后 zoompan/定帧）、
 *    anchor 偏置表达式、无 paths/无 anchor 段逐字节 = M53 形态；
 *  - template：photo-montage v2 新输入面 / ken_burns auto / analyze 步 when 门控 / 桥 11 键映射；
 *  - live：4 图 duo + kb:auto 实弹成片（段数/时长/尺寸/溯源）；bgm_mode=auto 库内两曲自动选曲
 *    （params.bgm.auto_selected + 非静音 + 零用量）；music_gen fetch 桩成功（资产+usage 口径+请求契约）
 *    与契约失败降级库内（新增 usage 零行）；run E 非混剪态（短剧 compose 形态）bgm_mode 即开关接入。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m54', { bridge: ['templates'] })

const SECTIONS = ['pure', 'args', 'template', 'live'] as const

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m54')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log,
  title: 'M54',
  checker,
  cleanup,
  sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成（零真实执行）')
    const { db } = await import('../src/db')
    const { apiProviders } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const rows = await db.select().from(apiProviders).where(eq(apiProviders.key, 'minimax_music'))
    check(rows.length === 1 && rows[0]!.serviceType === 'music', 'minimax_music 目录行已 seed（service_type=music 自由 text 零迁移）')
  },
  runners: {
    // ================= pure：auto 定向 / 锚点 / 拼贴分组 / 选曲（纯函数） =================
    pure: async () => {
      const { kbDirectionFor, classifyAnchor, kbAnchorFor, voteSubject, montageEnabled, pickBgm, scanBgmLibrary } =
        await import('../src/pipeline/actions/ffmpeg-merge/montage')
      const { planCollageSegments } = await import('../src/pipeline/actions/ffmpeg-merge/segments')

      // —— kbDirectionFor：既有模式逐字节零 diff ——
      check(kbDirectionFor('in', 0) === 'in' && kbDirectionFor('out', 1) === 'out', 'kb=in/out 行为不变')
      check(kbDirectionFor('alternate', 0) === 'in' && kbDirectionFor('alternate', 1) === 'out', 'alternate 偶推奇拉不变')
      check(kbDirectionFor('none', 0) === null, 'kb=none → 无方向')
      // —— auto 三态（阈值对称带 1.05）——
      check(kbDirectionFor('auto', 0, { w: 1600, h: 900 }) === 'in', 'auto 横图（16:9）→ 缓推')
      check(kbDirectionFor('auto', 0, { w: 900, h: 1600 }) === 'out', 'auto 竖图 → 缓拉')
      check(kbDirectionFor('auto', 0, { w: 1000, h: 1000 }) === 'in', 'auto 方形 → 缓推')
      check(kbDirectionFor('auto', 0, { w: 104, h: 100 }) === 'in' && kbDirectionFor('auto', 0, { w: 106, h: 100 }) === 'in', '近方带内/略横（1.04/1.06）→ 推')
      check(kbDirectionFor('auto', 0, { w: 95, h: 100 }) === 'out', '略竖（0.95 ≤ 1/1.05）→ 拉')
      check(kbDirectionFor('auto', 0) === 'in' && kbDirectionFor('auto', 0, { w: null, h: 100 }) === 'in', 'auto 无 hint/缺维度 → 宽容缓推')
      check(montageEnabled({ ken_burns: 'auto' }, { hasMixed: false, hasVideoSeg: false, strict: false }) === true, 'kb=auto → 混剪态触发')
      check(montageEnabled({ ken_burns: 'auto' }, { hasMixed: false, hasVideoSeg: false, strict: true }) === false, 'strict_delivery 下 auto 亦不触发（红线）')

      // —— classifyAnchor / kbAnchorFor / voteSubject ——
      check(classifyAnchor('主体位于画面左侧') === 'left' && classifyAnchor('subject on the right side') === 'right', 'composition 文本中英文方位关键词分类')
      check(classifyAnchor('居中构图') === 'center' && classifyAnchor('') === 'center' && classifyAnchor(null) === 'center', '无方位信息/空 → center')
      check(classifyAnchor('左边有树右边有人') === 'center', '左右同现 → center（矛盾不偏置）')
      check(kbAnchorFor('in', 'center') === null, 'center → null（zoompan 居中公式逐字节 = M53）')
      check(JSON.stringify(kbAnchorFor('in', 'left')) === JSON.stringify({ xw: 0.7, yw: 1 }), 'in+左 → x 权重 0.7（推向主体）')
      check(JSON.stringify(kbAnchorFor('out', 'left')) === JSON.stringify({ xw: 1.3, yw: 1 }), 'out+左 → x 权重 1.3（由主体拉远）')
      check(JSON.stringify(kbAnchorFor('in', 'right')) === JSON.stringify({ xw: 1.3, yw: 1 }), 'in+右 → 1.3')
      check(voteSubject(['左', '左', '右']) === 'left' && voteSubject(['左', '右']) === 'center' && voteSubject([]) === 'center', '多数决：严格多数偏移，平票/空 → center')

      // —— planCollageSegments ——
      const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, path: `in/p${i + 1}.png`, kind: 'image', durSec: 4 })) as never
      const segs = mk(4)
      check(planCollageSegments(segs, 'single', 3) === segs, 'single → 原样同引用（零 diff）')
      const duo = planCollageSegments(segs, 'duo', 2)
      check(duo.length === 2 && duo[0]!.paths?.length === 2 && duo[1]!.paths?.length === 2 && duo[0]!.durSec === 2 && duo[0]!.explicit === false, 'duo 四图 → 2 拼屏段，durSec=durationPerShot')
      check(duo[0]!.kind === 'image' && duo[0]!.path === 'in/p1.png' && duo[0]!.paths![1] === 'in/p2.png', '拼屏段 path=首图、paths 保时间轴顺序')
      const duoOdd = planCollageSegments(mk(3), 'duo', 2)
      check(duoOdd.length === 2 && duoOdd[1]!.paths === undefined, 'duo 奇数末段保持单图')
      const grid = planCollageSegments(segs, 'grid', 2)
      check(grid.length === 1 && grid[0]!.paths?.length === 4, 'grid 四图 → 单个四宫格段')
      const grid5 = planCollageSegments(mk(5), 'grid', 2)
      check(grid5.length === 2 && grid5[0]!.paths?.length === 4 && grid5[1]!.paths === undefined, 'grid 余 1 → 四图组 + 单图')
      const grid6 = planCollageSegments(mk(6), 'grid', 2)
      check(grid6.length === 2 && grid6[0]!.paths?.length === 4 && grid6[1]!.paths?.length === 2, 'grid 余 2 → 四图组 + duo 降级')
      const auto3 = planCollageSegments(mk(3), 'auto', 2)
      check(auto3.length === 3 && auto3.every((s) => !s.paths), 'auto 图数 <4 → 全单图不拼')
      const auto8 = planCollageSegments(mk(8), 'auto', 2)
      check(auto8.length === 4 && auto8[0]!.paths === undefined && auto8[1]!.paths?.length === 3 && auto8[2]!.paths?.length === 3 && auto8[3]!.paths === undefined, 'auto ≥4：首尾 hero 单图 + 中间三三拼屏')
      const mixed = planCollageSegments([{ id: 1, path: 'in/a.png', kind: 'image', durSec: 4 }, { id: 2, path: 'in/b.png', kind: 'image', durSec: 4 }, { id: 3, path: 'in/c.mp4', kind: 'video', durSec: 3 }, { id: 4, path: 'in/d.png', kind: 'image', durSec: 4 }] as never, 'duo', 2)
      check(mixed.length === 3 && mixed[1]!.kind === 'video' && mixed[1]!.id === 3 && mixed[2]!.paths === undefined, '视频段原样透传并充当组边界')

      // —— pickBgm：≥ 片长优先 → 最小差 → 最近片长 → updated_at desc ——
      const c = (id: number, d: number | null, upd = 0) => ({ id, path: `p${id}`, durationSec: d, updatedAt: upd })
      check(pickBgm([], 10) === null, '0 候选 → null（调用方 log 后按无 BGM 继续）')
      check(pickBgm([c(1, 30), c(2, 10)], 20)!.id === 1, '时长 ≥ 片长优先（30s 胜 10s）')
      check(pickBgm([c(1, 30), c(2, 25)], 20)!.id === 2, '双达标取与片长差最小（25s）')
      check(pickBgm([c(1, 18), c(2, 5)], 20)!.id === 1, '全不达标取最接近片长（18s）')
      check(pickBgm([c(1, null), c(2, 8)], 10)!.id === 2, '时长探测失败（null）排最后')
      check(pickBgm([c(1, 12, 100), c(2, 12, 200)], 10)!.id === 2, '同长 tie → updated_at desc')

      // —— scanBgmLibrary ——
      const libDir = mkdtempSync(join(tmpdir(), 'acs-m54-lib-'))
      writeFileSync(join(libDir, 'b-track.mp3'), 'x')
      writeFileSync(join(libDir, 'a-track.m4a'), 'x')
      writeFileSync(join(libDir, 'notes.txt'), 'x')
      const scanned = scanBgmLibrary(libDir)
      check(scanned.length === 2 && scanned[0]!.name === 'a-track.m4a' && scanned[1]!.name === 'b-track.mp3', '曲库扫描 mp3/m4a/wav 扩展名过滤 + 稳定排序')
      check(scanBgmLibrary(undefined).length === 0 && scanBgmLibrary(join(libDir, 'nope')).length === 0, 'env 未设/目录不存在 → 空数组不抛错')
    },

    // ================= args：collage phase-1 形状 + 锚点表达式 + 零 diff =================
    args: async () => {
      const { buildNormalizeArgs } = await import('../src/pipeline/actions/ffmpeg-merge/montage')
      const nb = (over: Record<string, unknown>) => ({ width: 320, height: 240, fps: 12, kb: null, clipHasAudio: null, outAbs: 'tmp/o.mp4', ...over } as never)
      const imgSeg = { id: 1, path: 'in/a.png', kind: 'image', durSec: 4 } as never
      const j = (r: string[]): string => r.join(' ')

      // —— 零 diff：anchor 缺省/null = M53 居中公式逐字节 ——
      const baseKb = j(buildNormalizeArgs(imgSeg, nb({ kb: 'in' })))
      const nullAnchor = j(buildNormalizeArgs(imgSeg, nb({ kb: 'in', anchor: null })))
      check(baseKb === nullAnchor, 'anchor 缺省 vs 显式 null → args 逐字节一致（M53 基线）')
      check(baseKb.includes("zoompan=z='min(1+0.005*on,1.25)'") && baseKb.includes("x='iw-iw/zoom'") && !baseKb.includes('*0.7'), '居中公式形态保留（无锚点乘数泄漏）')

      // —— anchor 偏置表达式 ——
      const leftIn = j(buildNormalizeArgs(imgSeg, nb({ kb: 'in', anchor: { xw: 0.7, yw: 1 } })))
      check(leftIn.includes("x='(iw-iw/zoom)*0.7'") && leftIn.includes("y='ih-ih/zoom'"), 'in+主体偏左：x 加权 0.7、y 保持居中形态')
      const rightOut = j(buildNormalizeArgs(imgSeg, nb({ kb: 'out', anchor: { xw: 0.7, yw: 1 } })))
      check(rightOut.includes("x='(iw-iw/zoom)*0.7'") && rightOut.includes("max(1.25-"), 'out 方向公式不变，锚点乘数独立生效')

      // —— collage duo（paths 2）：N 路 -i + 等分 cell + vstack 整屏 + 静音轨索引 ——
      const duoSeg = { id: 1, path: 'in/a.png', paths: ['in/a.png', 'in/b.png'], kind: 'image', durSec: 4 } as never
      const duoArgs = j(buildNormalizeArgs(duoSeg, nb({})))
      check(duoArgs.includes('-i in/a.png -i in/b.png -f lavfi -i anullsrc'), 'duo：两路图片 -i + lavfi 静音轨第三输入')
      check(duoArgs.includes('[0:v]scale=320:120:force_original_aspect_ratio=increase,crop=320:120[c0]') && duoArgs.includes('[c0][c1]vstack=inputs=2[tile]'), 'duo：cell 等分（320x120）→ vstack 整屏 [tile]')
      check(duoArgs.includes('[tile]scale=320:240') && duoArgs.includes('[2:a]') && duoArgs.includes('-frames:v 1'), 'tile 接定帧归一链 + 静音轨按成员数索引 [2:a]')

      // —— collage grid（paths 4）：xstack 2x2 布局表 ——
      const gridSeg = { id: 1, path: 'in/a.png', paths: ['a', 'b', 'c', 'd'], kind: 'image', durSec: 4 } as never
      const gridArgs = j(buildNormalizeArgs(gridSeg, nb({})))
      check(gridArgs.includes('xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[tile]'), 'grid：四路 xstack 2x2 布局表')
      check(gridArgs.includes('scale=160:120:force_original_aspect_ratio=increase'), 'grid：cell 半宽半高（160x120）')

      // —— collage + kb：tile 后走 ×2 超采样 zoompan 连续产出 ——
      const duoKb = j(buildNormalizeArgs(duoSeg, nb({ kb: 'in' })))
      check(duoKb.includes("[tile]scale=640:480:force_original_aspect_ratio=increase,crop=640:480,zoompan=z='min(1+0.005*on,1.25)'") && !duoKb.includes('-frames:v 1'), 'collage+kb=in：tile 底 ×2 超采样 zoompan（无定帧限制）')
      const trio = j(buildNormalizeArgs({ id: 1, path: 'a', paths: ['a', 'b', 'c'], kind: 'image', durSec: 4 } as never, nb({})))
      check(trio.includes('vstack=inputs=3[tile]'), '三拼（grid/auto 降级形态）→ vstack 三行')
      // 无 paths 单图段与 M53 形状逐字节 = pure 图链（-i 单输入、无 xstack/vstack）
      check(!baseKb.includes('tile') && !baseKb.includes('vstack') && !baseKb.includes('xstack'), '单图段零 diff：不引入 tile 链任何痕迹')
    },

    // ================= template：photo-montage v2 输入面与 analyze 门控 =================
    template: async () => {
      const { loadTemplate, templateFlags, KNOWN_ACTIONS } = await import('../src/pipeline/loader')
      const t = loadTemplate('photo-montage')
      check(templateFlags('photo-montage').builtin === true, 'photo-montage 仍标记 builtin=true')
      check(t.version === 2, `模板版本升至 2（实际 ${t.version}）`)
      const inputsByKey = new Map((t.inputs ?? []).map((i) => [i.key, i]))
      check(['layout', 'bgm_mode', 'bgm_prompt', 'analyze_composition'].every((k) => inputsByKey.has(k)), 'M54 新输入四键齐全')
      check(inputsByKey.get('bgm_mode')?.default === 'auto' && inputsByKey.get('layout')?.default === 'single' && inputsByKey.get('analyze_composition')?.default === false, '默认值：bgm auto / layout single / 构图感知关（零 LLM 卖点保持）')
      const kbIn = inputsByKey.get('ken_burns')!
      check((kbIn.options as readonly string[]).includes('auto') && kbIn.default === 'alternate', 'ken_burns 选项含 auto，默认仍 alternate（存量行为不变）')
      const analyze = t.steps.find((s) => s.key === 'analyze')
      check(!!analyze && analyze.action === 'image_analyze' && String(analyze.when) === 'input.analyze_composition == true', 'analyze 步 image_analyze + when 显式门控')
      check(!!analyze && (analyze.inputs as Record<string, string>).images === 'input.photos', 'analyze 输入接 photos')
      const compose = t.steps.find((s) => s.key === 'compose')!
      check((compose.after as readonly string[]).includes('analyze') && compose.after_skipped === 'continue', 'compose after 含 analyze 且跳过时续行')
      const mapIn = compose.inputs as Record<string, string>
      check(mapIn.composition === 'steps.analyze.assets', 'composition 通道接 analyze 产物')
      check(['layout', 'bgm_mode', 'bgm_prompt', 'analyze_composition'].every((k) => mapIn[k] === `input.${k}`), '桥新增 4 键 inputs 映射齐全（合计 11 键）')
      check((KNOWN_ACTIONS as readonly string[]).includes('image_analyze'), 'image_analyze 在 KNOWN_ACTIONS')
    },

    // ================= live：duo 实弹 + 库内选曲 + music_gen 桩与降级 =================
    live: async () => {
      const { db } = await import('../src/db')
      const { projects, pipelineRuns, pipelineSteps, assets, usageRecords, apiConfigs } = await import('../src/db/schema')
      const { eq, and } = await import('drizzle-orm')
      const { loadTemplate } = await import('../src/pipeline/loader')
      const { engine } = await import('../src/pipeline/engine')
      const { ensureProjectDirs, relPathOf, absPathOf, registerAsset } = await import('../src/services/storage')
      const { resolveFfmpeg, resolveFfprobe } = await import('../src/services/ffmpeg')
      await import('../src/services/music-gen')
      const ffmpeg = resolveFfmpeg()!
      const ffprobe = resolveFfprobe()!
      const gen = (abs: string, args: string[]): void => {
        const r = spawnSync(ffmpeg, ['-y', '-v', 'error', ...args, abs], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
        if (r.status !== 0) throw new Error(`探针生成素材失败 ${abs}: ${(r.stderr ?? '').slice(-200)}`)
      }
      const [proj] = await db.insert(projects).values({ name: 'm54-live', genre: 'other', templateKey: 'photo-montage', status: 'active', settings: '{}', tags: '[]', createdAt: Date.now(), updatedAt: Date.now() }).returning()
      const pid = proj!.id
      ensureProjectDirs(pid)
      const reg = async (kind: 'image' | 'video' | 'audio', name: string, rel: string, duration?: number): Promise<number> =>
        (await registerAsset(pid, { name, kind, purpose: 'source', relPath: rel, ext: name.split('.').pop()!, mime: kind === 'image' ? 'image/png' : kind === 'audio' ? 'audio/mpeg' : 'video/mp4', ...(duration ? { duration } : {}) })).id
      const mkImg = async (lavfi: string, id: string): Promise<number> => {
        const rel = relPathOf(pid, 'source', `${id}-${Date.now()}.png`)
        gen(absPathOf(rel), ['-f', 'lavfi', '-i', lavfi, '-frames:v', '1', '-update', '1'])
        return reg('image', `${id}.png`, rel)
      }
      // 2 横（400x300）+ 2 竖（300x400）：kb:auto 前组横→in、后组竖→out
      const wideA = await mkImg('color=c=red:s=400x300', 'wide-a')
      const wideB = await mkImg('color=c=green:s=400x300', 'wide-b')
      const tallA = await mkImg('color=c=blue:s=300x400', 'tall-a')
      const tallB = await mkImg('color=c=yellow:s=300x400', 'tall-b')

      const runOf = async (id: number) => (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)))[0]!
      const settle = async (id: number): Promise<Awaited<ReturnType<typeof runOf>>> => {
        for (let i = 0; i < 2400; i++) {
          if (!engine.isRunning(id)) return runOf(id)
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error(`live run ${id} 未收敛`)
      }
      const startRun = async (input: Record<string, unknown>): Promise<number> => {
        const now = Date.now()
        const [run] = await db.insert(pipelineRuns).values({
          projectId: pid, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(loadTemplate('photo-montage')),
          status: 'queued', input: JSON.stringify(input), createdAt: now, updatedAt: now,
        } as never).returning()
        engine.startRun(run!.id)
        return run!.id
      }
      const finalOf = async (runId: number) => (await db.select().from(assets).where(and(eq(assets.runId, runId), eq(assets.purpose, 'final_video'))))[0]!
      const streamInfo = (abs: string): { dur: number; w: number; h: number; aStreams: number } => {
        const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', abs], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
        const doc = JSON.parse(r.stdout || '{}') as { format?: { duration?: string }; streams?: Array<{ width?: number; height?: number; codec_type?: string }> }
        const v = (doc.streams ?? []).find((s) => s.codec_type === 'video')!
        return { dur: Number(doc.format?.duration ?? 0), w: v.width ?? 0, h: v.height ?? 0, aStreams: (doc.streams ?? []).filter((s) => s.codec_type === 'audio').length }
      }
      const usageOf = (runId: number) => db.select().from(usageRecords).where(eq(usageRecords.runId, runId))

      const fetchBak = globalThis.fetch
      let runA = 0
      try {
        // —— run A：duo 拼贴 + kb:auto + bgm none（零网络零计费）——
        globalThis.fetch = (async () => { throw new Error('M54 live A/B 段禁止网络（零付费红线）') }) as typeof fetch
        runA = await startRun({
          photos: [wideA, wideB, tallA, tallB], duration_per_shot: 2, fps: 12, resolution: '320x240',
          ken_burns: 'auto', layout: 'duo', bgm_mode: 'none', keep_clip_audio: false,
        })
        const rA = await settle(runA)
        check(rA.status === 'completed', `run A duo+auto 全链 completed（实际 ${rA.status}${rA.error ? ` / ${String(rA.error).slice(0, 160)}` : ''}）`)
        const stepsA = await db.select().from(pipelineSteps).where(eq(pipelineSteps.runId, runA))
        check(stepsA.find((s) => s.stepKey === 'analyze')?.status === 'skipped', 'analyze_composition 未开启 → analyze 步跳过、compose 续行')
        const fvA = await finalOf(runA)
        const infoA = streamInfo(absPathOf(fvA!.relPath!))
        check(Math.abs(infoA.dur - 4) <= 0.6 && infoA.w === 320 && infoA.h === 240, `拼贴成片 ≈4s（2 段×2s）/320x240（实际 ${infoA.dur.toFixed(2)}s/${infoA.w}x${infoA.h}）`)
        check(infoA.aStreams === 0, 'bgm none + 纯照片 → 无音轨（不造假轨红线）')
        const pa = JSON.parse(fvA.params ?? '{}') as Record<string, any>
        check(pa.montage?.layout === 'duo' && pa.montage?.collage_segments === 2 && pa.montage?.normalized_segments === 2, `拼贴溯源 layout=duo/2 拼屏段/归一后 2 段（实际 ${JSON.stringify(pa.montage)}）`)
        check(pa.montage?.ken_burns === 'auto' && pa.montage?.kb_applied === 2, 'auto 溯源 kb_applied=2（横首图推、竖首图拉）')
        check(pa.bgm === null, 'bgm_mode=none → bgm 溯源 null')
        check((await usageOf(runA)).length === 0, 'run A 零用量（库内链不经 API）')

        // —— run B：bgm_mode=auto 库内两曲自动选曲 ——
        const relLong = relPathOf(pid, 'audio', 'bgm-long.mp3')
        gen(absPathOf(relLong), ['-f', 'lavfi', '-i', 'sine=frequency=523:duration=10', '-c:a', 'libmp3lame', '-b:a', '64k'])
        const longId = await reg('audio', 'bgm-long.mp3', relLong, 10)
        const relShort = relPathOf(pid, 'audio', 'bgm-short.mp3')
        gen(absPathOf(relShort), ['-f', 'lavfi', '-i', 'sine=frequency=392:duration=2', '-c:a', 'libmp3lame', '-b:a', '64k'])
        await reg('audio', 'bgm-short.mp3', relShort, 2)
        const runB = await startRun({
          photos: [wideA, wideB, tallA, tallB], duration_per_shot: 2, fps: 12, resolution: '320x240',
          ken_burns: 'none', layout: 'single', bgm_mode: 'auto', keep_clip_audio: false,
        })
        const rB = await settle(runB)
        check(rB.status === 'completed', `run B 库内自动选曲 completed（实际 ${rB.status}${rB.error ? ` / ${String(rB.error).slice(0, 160)}` : ''}）`)
        const fvB = await finalOf(runB)
        const pb = JSON.parse(fvB.params ?? '{}') as Record<string, any>
        check(pb.bgm?.auto_selected === true && pb.bgm?.asset_id === longId, `选曲命中 10s 曲（≥ 片长 8s 优先）+ auto_selected 溯源（实际 ${JSON.stringify(pb.bgm)}）`)
        const boundB = (await db.select().from(assets).where(and(eq(assets.runId, runB), eq(assets.purpose, 'bgm')))).filter((a) => !a.deletedAt)
        check(boundB.length === 1 && boundB[0]!.id === longId, '绑定语义：本 run 有效 bgm 行至多 1 条')
        const infoB = streamInfo(absPathOf(fvB.relPath!))
        check(infoB.aStreams === 1, '成片含 1 条音轨（自动 BGM）')
        const vd = spawnSync(ffmpeg, ['-v', 'info', '-i', absPathOf(fvB.relPath!), '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
        const mean = Number(/mean_volume:\s*(-[\d.]+)\s*dB/.exec(String(vd.stderr))?.[1] ?? NaN)
        check(Number.isFinite(mean) && mean > -90, `自动配乐后非数字静音（mean_volume=${mean}dB）`)
        check((await usageOf(runB)).length === 0, '库内选曲零计费（usage_records 0 行）')

        // —— run E（M54-B）：非混剪态智能选曲（短剧 compose_video 形态：纯 images 输入 + bgm_mode 映射，无 montage）——
        const tplSnap = JSON.parse(JSON.stringify(loadTemplate('photo-montage'))) as { steps: Array<Record<string, any>> }
        tplSnap.steps = tplSnap.steps.filter((s) => s.key === 'compose')
        const cstep = tplSnap.steps[0]!
        delete cstep.gate
        delete cstep.after
        cstep.inputs = { images: 'input.photos' }
        cstep.params = { fps: 12, resolution: '320x240', duration_per_shot: 2, bgm_mode: 'auto' }
        const relE = relPathOf(pid, 'audio', 'bgm-e.mp3')
        gen(absPathOf(relE), ['-f', 'lavfi', '-i', 'sine=frequency=659:duration=12', '-c:a', 'libmp3lame', '-b:a', '64k'])
        const eBgmId = await reg('audio', 'bgm-e.mp3', relE, 12)
        const nowE = Date.now()
        const [runE] = await db.insert(pipelineRuns).values({
          projectId: pid, templateKey: 'photo-montage', templateSnapshot: JSON.stringify(tplSnap),
          status: 'queued', input: JSON.stringify({ photos: [wideA, wideB] }), createdAt: nowE, updatedAt: nowE,
        } as never).returning()
        engine.startRun(runE.id)
        const rE = await settle(runE!.id)
        check(rE.status === 'completed', `run E 非混剪链自动选曲 completed（实际 ${rE.status}${rE.error ? ` / ${String(rE.error).slice(0, 160)}` : ''}）`)
        const fvE = await finalOf(runE!.id)
        const pe = JSON.parse(fvE.params ?? '{}') as Record<string, any>
        check(pe.bgm?.auto_selected === true && pe.bgm?.asset_id === eBgmId, `非混剪态 bgm_mode 即开关：命中 12s 新曲（≥ 片长 4s；2s 短曲不足、long 已绑 run B 不抢）（实际 ${JSON.stringify(pe.bgm)}）`)
        check(pe.montage === null, '非混剪态 montage 溯源为 null（短剧 compose 形态零污染）')
        const infoE = streamInfo(absPathOf(fvE.relPath!))
        check(infoE.aStreams === 1, '非混剪成片含 1 条自动 BGM 音轨')
        check((await usageOf(runE!.id)).length === 0, 'run E 零用量零网络（库内链，禁网桩内完成）')
      } finally {
        globalThis.fetch = fetchBak
      }

      // —— run C/D：music_gen fetch 桩（零真实付费）：成功契约 + 失败降级 ——
      const longRow = (await db.select().from(assets).where(and(eq(assets.projectId, pid), eq(assets.name, 'bgm-long.mp3'))))[0]!
      const audioHex = readFileSync(absPathOf(longRow.relPath!)).toString('hex')
      await db.insert(apiConfigs).values({
        name: 'probe minimax music', providerKey: 'minimax_music', serviceType: 'music',
        baseUrl: 'https://api.minimax.cn', model: 'music-3.0', apiKeyRef: 'env:M54_PROBE_MUSIC_KEY',
        isActive: 1, isDefault: 1, priority: 0, extra: '{}', createdAt: Date.now(), updatedAt: Date.now(),
      } as never)
      process.env.M54_PROBE_MUSIC_KEY = 'probe-key-not-real'
      const musicCalls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = []
      let failNextMusic = false
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (!url.includes('music_generation')) throw new Error(`M54 live 桩仅放行 music 端点：${url}`)
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        const headers = (init?.headers ?? {}) as Record<string, string>
        musicCalls.push({ url, auth: String(headers.Authorization ?? ''), body })
        const doc = failNextMusic
          ? { data: null, base_resp: { status_code: 1004, status_msg: 'api rate limit group concurrent limit reach max' } }
          : { data: { audio: audioHex, status: 2 }, extra_info: { music_duration: 5000 }, analysis_info: null, base_resp: { status_code: 0, status_msg: 'success' } }
        return new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as typeof fetch
      try {
        const runC = await startRun({
          photos: [wideA], duration_per_shot: 2, fps: 12, resolution: '320x240',
          ken_burns: 'none', layout: 'single', bgm_mode: 'music_gen', bgm_prompt: '轻快的相册回顾器乐', keep_clip_audio: false,
        })
        const rC = await settle(runC)
        check(rC.status === 'completed', `run C music_gen 成功链 completed（实际 ${rC.status}${rC.error ? ` / ${String(rC.error).slice(0, 160)}` : ''}）`)
        const call = musicCalls[0]
        check(!!call && call.url === 'https://api.minimax.cn/v1/music_generation' && call.auth === 'Bearer probe-key-not-real', '请求契约：/v1/music_generation + Bearer 鉴权')
        check(call!.body.model === 'music-3.0' && call!.body.prompt === '轻快的相册回顾器乐' && call!.body.is_instrumental === true && call!.body.output_format === 'hex', '请求体契约：model/prompt 透传 + 纯音乐 hex 形态')
        const fvC = await finalOf(runC)
        const pc = JSON.parse(fvC.params ?? '{}') as Record<string, any>
        check(pc.bgm?.auto_selected === true, `AI 生成 BGM 绑定 + auto_selected 溯源（实际 ${JSON.stringify(pc.bgm)}）`)
        const aiRow = (await db.select().from(assets).where(and(eq(assets.projectId, pid), eq(assets.purpose, 'bgm'), eq(assets.runId, runC))))[0]!
        check(String(aiRow.tags ?? '').includes('bgm_ai') && aiRow.duration === 5, '生成资产：tags bgm_ai + extra_info.music_duration 时长落行（5s）')
        const usageC = await usageOf(runC)
        check(usageC.length === 1 && usageC[0]!.kind === 'music' && usageC[0]!.unit === 'second' && usageC[0]!.quantity === 5 && usageC[0]!.provider === 'minimax_music', `用量口径：kind=music/second/qty=5/provider=minimax_music（实际 ${JSON.stringify(usageC.map(u => ({ k: u.kind, q: u.quantity, p: u.provider })))}）`)

        // —— run D：契约失败（status_code=1004）→ 降级库内 auto，绝不断链、失败不计费 ——
        failNextMusic = true
        const runD = await startRun({
          photos: [tallA], duration_per_shot: 2, fps: 12, resolution: '320x240',
          ken_burns: 'none', layout: 'single', bgm_mode: 'music_gen', keep_clip_audio: false,
        })
        const rD = await settle(runD)
        check(rD.status === 'completed', `run D 生乐失败降级链 completed（绝不断链；实际 ${rD.status}${rD.error ? ` / ${String(rD.error).slice(0, 160)}` : ''}）`)
        check(musicCalls.length === 2 && failNextMusic, 'run D 已实际请求生乐端点一次（降级前有真实调用痕迹）')
        const fvD = await finalOf(runD)
        const pd = JSON.parse(fvD.params ?? '{}') as Record<string, any>
        const shortRow = (await db.select().from(assets).where(and(eq(assets.projectId, pid), eq(assets.name, 'bgm-short.mp3'))))[0]!
        check(pd.bgm?.auto_selected === true && pd.bgm?.asset_id === shortRow.id, `降级命中库内候选（2s 短曲；10s 已绑 run B 不抢）（实际 ${JSON.stringify(pd.bgm)}）`)
        const usageD = await usageOf(runD)
        check(usageD.length === 0, '生乐失败零计费（run D usage_records 0 行，付费面只在成功时计量）')
      } finally {
        globalThis.fetch = fetchBak
        delete process.env.M54_PROBE_MUSIC_KEY
      }
    },
  },
})

