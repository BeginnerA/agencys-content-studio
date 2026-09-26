/**
 * precision-rework 探针（字幕精确返修首切片）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-precision-rework.ts [--section=contract]
 *   或统一入口：npx tsx scripts/run-probes.ts --only=precision-rework --jobs=1
 *
 * 隔离策略：isolatedEnv('precision-rework') 一次性临时目录；P1/P2 契约与快照层为纯函数，
 * 零网络、零 DB、零付费、零文件系统写入（fetch 全程阻断兜底）。
 * 覆盖规格 §11 验收 1（单 cue 文字/200ms 平移/多 cue 同移/其他 cue 不动）、
 * §4 输入限制、整体拒绝语义（无部分生效）、稳定标识与规范化序，
 * §6.1 有效字幕快照（普通平移/严格路径/一句多 cue/片头/关闭烧录证据），
 * §5.1/§5.2 台账与字幕版本持久化（隔离库 initDb：幂等回放/冲突/终态回执/不可变版本链/受控键），
 * 以及 §5/§6 能力判定与结构化预览（跨项目/在途/缺快照/快照损坏/下游付费均拦断；预览零执行态写入），
 * 以及 §5.3 原子确认（同事务领用版本/指针/重置合成步与回执；并发只应用一次、响应丢失可回放、指纹漂移拒绝），
 * 以及 §6.2 合成消费（人工修订显示输入接管 fail closed / 无烧录快速路径逐字节复制与任一依赖漂移拒绝），
 * 以及 §6.2/§5.2-104/§7 重合成过期复验（依赖指纹消费前终检、内部键不绕白名单、续跑不盲拷指针、被引用字幕不可清理），
 * 以及 §7/P8 成果版本投影（运行级 API 幂等面、当前修订/待审/待重合成四态区分、下载固定不可变版本、旧成片不伪装已更新），
 * 以及 §8/P9 工程字幕与 sidecar（共享 cue 读取、FCPXML/OTIO 字幕轨取有效快照不覆盖人工修订、对白轨不动、EDL 不伪装字幕）。
 * compose-input 分节（切片2）拆至 ./precision-rework-compose-input（m26 split-audit 红线单文件 ≤800 行）。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'
import {
  api, setApi, fixture, clone, createFixtureTools,
  runComposeSection, runStaleSection, runProjectionSection, runExchangeSection, runParseSection,
  type SubtitleCueT, type EffSnap, type ApiShape,
} from './precision-rework-sections'
import { runComposeInputSection } from './precision-rework-compose-input'
import { runShotDurationSection } from './precision-rework-shot-duration'

const { cleanup } = isolatedEnv('precision-rework')

const SECTIONS = ['contract', 'snapshot', 'ledger', 'preview', 'apply', 'compose', 'compose-input', 'shot-duration', 'stale', 'projection', 'exchange', 'parse'] as const


async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-precision-rework')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  // src 模块必须在 isolatedEnv 之后动态加载，经 setApi 注入共享分节模块（ESM live binding：两模块见同一实例）
  setApi({
    ...(await import('../src/services/rework/subtitle-text')),
    ...(await import('../src/services/rework/contract')),
    ...(await import('../src/pipeline/actions/ffmpeg-merge/effective-subtitle')),
    ...(await import('../src/pipeline/actions/ffmpeg-merge/align')),
    ...(await import('../src/pipeline/actions/ffmpeg-merge/timeline-snapshot')),
  } as unknown as ApiShape)
  globalThis.fetch = (async (): Promise<Response> => {
    throw new Error('precision-rework 探针禁止任何网络调用')
  }) as typeof fetch

  const errCode = (r: { ok: false; errors: Array<{ code: string }> }): string => r.errors[0]?.code ?? '?'

  const runContract = async (): Promise<void> => {
    const { cues, durationMs } = fixture()
    const [c1, c2, c3] = cues as [SubtitleCueT, SubtitleCueT, SubtitleCueT]

    /* ── 解析与序列化 ── */
    check(cues.length === 3, '夹具解析出 3 条 cue')
    check(c2.text === '第二句\n续行', '多行文本保留正常换行')
    check(c3.startMs === 6000 && c2.endMs === 5000, 'CRLF 夹具毫秒换算准确')
    const loose = api.parseSubtitleSrt('1\n00:00:01.500 --> 0:00:03,250\n甲\n')
    check(loose.ok && loose.cues[0]!.startMs === 1500 && loose.cues[0]!.endMs === 3250, '兼容 . 分隔毫秒与单位小时')
    const round = api.parseSubtitleSrt(api.serializeSubtitleSrt(cues))
    check(round.ok && JSON.stringify(round.cues) === JSON.stringify(cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))), '序列化→解析往返逐字段一致')

    const bad = (srt: string, code: string, msg: string): void => {
      const r = api.parseSubtitleSrt(srt)
      check(!r.ok && (r as { error: { code: string } }).error.code === code, msg)
    }
    bad('1\n没有时间的正文\n', 'invalid_srt', '缺时间戳行整体拒绝')
    bad('1\n00:00:00,000 --> 00:00:01,000\n\n', 'invalid_srt', '空文本 cue 拒绝（不静默跳过）')
    bad('1\n00:00:00,000 --> 00:00:01,000\n含\u0007控制符\n', 'unsafe_text', '控制字符拒绝')
    bad('1\n00:00:00,000 --> 00:00:01,000\n{\\an8}覆盖标签\n', 'unsafe_text', 'ASS 覆盖标签拒绝')
    bad('1\n00:00:00,000 --> 00:00:01,000\n<b>粗体</b>\n', 'unsafe_text', 'HTML 标签拒绝')
    bad('1\n00:00:02,000 --> 00:00:01,000\n倒挂\n', 'invalid_time', 'start>=end 拒绝')
    bad('1\n00:00:00,000 --> 00:00:03,000\n前句\n\n2\n00:00:02,000 --> 00:00:04,000\n重叠\n', 'overlapping_cues', '时间重叠整体拒绝')
    bad('文字行\n1\n00:00:00,000 --> 00:00:01,000\n甲\n', 'invalid_srt', '时间戳前非序号内容拒绝')
    bad('   \n', 'invalid_srt', '空字幕拒绝（无 cue 可编辑）')
    bad('1\n00:00:00,000 --> 00:00:01,000\n' + '字'.repeat(api.SRT_MAX_CUE_TEXT_CHARS + 1) + '\n', 'unsafe_text', '单 cue 超 2000 字符拒绝')
    const huge = 'x'.repeat(3 * 1024 * 1024)
    bad(huge, 'srt_too_large', '超 2 MiB 整体拒绝')
    bad(Array.from({ length: 5001 }, (_, i) => `${i + 1}\n00:00:0${i % 5},${i % 1000} --> 00:00:0${i % 5 + 1},000\ncue`).join('\n\n'), 'too_many_cues', '超 5000 cue 整体拒绝')

    /* ── 稳定标识 ── */
    const tagA = api.subtitleBaseTag('fixture-source-hash')
    check(tagA === api.subtitleBaseTag('fixture-source-hash') && tagA !== api.subtitleBaseTag('sha-src-2'), '基准 tag 同源稳定、异源不同')
    check(c1.id === api.makeCueId(tagA, 1) && c3.id === api.makeCueId(tagA, 3), 'cue 标识=基准 tag+ordinal，修订中稳定')
    check(api.attachCueIds(cues, 'other')[0]!.id !== c1.id, '跨基准不沿用旧标识')
    check(api.validateSubtitleText(''.padStart(api.SRT_MAX_CUE_TEXT_CHARS, '甲')) === null, '恰 2000 字符合法')
    check(api.validateSubtitleText('上句\n\n下句') !== null, '文本内空行拒绝（破坏序列化往返）')

    /* ── 变更请求 schema ── */
    const okReq = api.parseSubtitleChanges([
      { kind: 'subtitle-text', cueId: c1.id, text: '新第一句' },
      { kind: 'subtitle-time', cueId: c2.id, startMs: 2700, endMs: 5000 },
      { kind: 'subtitle-shift', cueIds: [c3.id], deltaMs: 200 },
    ])
    check(okReq.ok, '三类合法变更通过 schema')
    const rej = (input: unknown, msg: string): void => {
      const r = api.parseSubtitleChanges(input)
      check(!r.ok, msg)
    }
    rej([], '空变更列表拒绝')
    rej([{ kind: 'subtitle-unknown', cueId: c1.id }], '未知 kind 拒绝')
    rej([{ kind: 'subtitle-text', cueId: c1.id, text: '甲', extra: 1 }], '额外字段（strict）拒绝')
    rej([{ kind: 'subtitle-time', cueId: c1.id, startMs: 1.5, endMs: 2 }], '小数毫秒拒绝')
    rej([{ kind: 'subtitle-time', cueId: c1.id, startMs: '1000', endMs: 2000 }], '字符串毫秒拒绝')
    rej([{ kind: 'subtitle-time', cueId: c1.id, startMs: NaN, endMs: 2000 }], 'NaN 拒绝')
    rej([{ kind: 'subtitle-time', cueId: c1.id, startMs: Infinity, endMs: 2000 }], 'Infinity 拒绝')
    rej([{ kind: 'subtitle-shift', cueIds: [c1.id], deltaMs: 0 }], '零平移量定向拒绝')
    rej({ not: 'array' }, '非数组拒绝')

    /* ── 应用语义：最小改动 + diff ── */
    const textRes = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: c2.id, text: '改后文本' }] as never[], durationMs })
    check(textRes.ok && textRes.diffs.length === 1 && textRes.diffs[0]!.field === 'text' && textRes.diffs[0]!.before === '第二句\n续行' && textRes.diffs[0]!.after === '改后文本', '单 cue 文字修改产生精确前后 diff')
    check(textRes.ok && textRes.finalCues.length === 3 && JSON.stringify(textRes.finalCues[0]) === JSON.stringify(c1) && JSON.stringify(textRes.finalCues[2]) === JSON.stringify(c3), '文字修改只改变目标 cue，其他 cue 与数量顺序不动')

    const singleShift = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c2.id], deltaMs: 200 } as never], durationMs })
    check(singleShift.ok && singleShift.finalCues[1]!.startMs === 3200 && singleShift.finalCues[1]!.endMs === 5200, '单 cue 后移 200ms 精确命中')
    check(!!singleShift.ok && JSON.stringify(singleShift.finalCues[0]) === JSON.stringify(c1) && JSON.stringify(singleShift.finalCues[2]) === JSON.stringify(c3), '200ms 平移不挤动其他字幕')

    const multiShift = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c1.id, c2.id], deltaMs: 200 } as never], durationMs })
    check(multiShift.ok && multiShift.finalCues[0]!.startMs === 200 && multiShift.finalCues[0]!.endMs === 2200 && multiShift.finalCues[1]!.startMs === 3200 && multiShift.finalCues[1]!.endMs === 5200, '多 cue 同移 200ms 全部精确')
    check(multiShift.ok && multiShift.diffs.length === 4, '多 cue 平移 diff 覆盖 start/end 两字段×两 cue')
    check(!!multiShift.ok && multiShift.diffs.every((d) => Number(d.after) - Number(d.before) === 200), '每条 diff 位移量恰为 200ms')

    const negShift = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c1.id], deltaMs: -200 } as never], durationMs })
    check(!negShift.ok && errCode(negShift) === 'out_of_range', '负平移越出 0 起点整体拒绝')
    const overShift = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c3.id], deltaMs: 1001 } as never], durationMs })
    check(!overShift.ok && errCode(overShift) === 'out_of_range', '平移终点超成片时长整体拒绝（不静默裁切）')
    const bigShift = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c1.id], deltaMs: api.MAX_SHIFT_DELTA_MS + 1000 } as never], durationMs })
    check(!bigShift.ok, '超 ±10 分钟平移幅度拒绝')

    const overlapApply = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-time', cueId: c1.id, startMs: 0, endMs: 3500 } as never], durationMs })
    check(!overlapApply.ok && errCode(overlapApply) === 'overlapping_cues', '改时与下一条重叠整体拒绝')
    const adjacent = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-time', cueId: c1.id, startMs: 0, endMs: 3000 } as never], durationMs })
    check(adjacent.ok && adjacent.finalCues[0]!.endMs === 3000, '相邻 end=下一条 start 合法')
    const atDuration = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-time', cueId: c3.id, startMs: 5000, endMs: durationMs } as never], durationMs })
    check(atDuration.ok, '终点恰等于成片实测时长合法（<= 界）')
    const inverted = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-time', cueId: c3.id, startMs: 8000, endMs: 8000 } as never], durationMs })
    check(!inverted.ok && errCode(inverted) === 'invalid_time', 'start==end 拒绝')

    const unknown = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: 'srt:deadbeef:c9', text: '甲' } as never], durationMs })
    check(!unknown.ok && errCode(unknown) === 'unknown_cue', '未知 cue 标识拒绝（不跨基准沿用）')
    const dupText = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: c1.id, text: '甲' }, { kind: 'subtitle-text', cueId: c1.id, text: '乙' }] as never[], durationMs })
    check(!dupText.ok && errCode(dupText) === 'conflicting_changes', '同 cue 两次文字修改冲突拒绝')
    const mixed = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: c1.id, text: '甲' }, { kind: 'subtitle-time', cueId: c1.id, startMs: 0, endMs: 1000 }] as never[], durationMs })
    check(!mixed.ok && errCode(mixed) === 'conflicting_changes', '同 cue 文字+时间跨 kind 组合冲突拒绝')
    const dupShiftIds = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c1.id, c1.id], deltaMs: 100 } as never], durationMs })
    check(!dupShiftIds.ok && errCode(dupShiftIds) === 'conflicting_changes', '平移目标内部重复拒绝')
    const dupAcrossShift = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-shift', cueIds: [c1.id, c2.id], deltaMs: 100 }, { kind: 'subtitle-shift', cueIds: [c2.id], deltaMs: 200 }] as never[], durationMs })
    check(!dupAcrossShift.ok && errCode(dupAcrossShift) === 'conflicting_changes', '两个平移集合相交拒绝')

    const noEffect = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: c1.id, text: '第一句' } as never], durationMs })
    check(!noEffect.ok && errCode(noEffect) === 'no_effect', '与原值相同的修改判定 no_effect 拒绝')
    const unsafeApply = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: c1.id, text: '<i>x</i>' } as never], durationMs })
    check(!unsafeApply.ok && errCode(unsafeApply) === 'unsafe_text', '不安全文字在应用层二次拒绝')
    const partial = api.applySubtitleChanges({ cues: clone(cues), changes: [{ kind: 'subtitle-text', cueId: c1.id, text: '合法新值' }, { kind: 'subtitle-text', cueId: c2.id, text: '' }] as never[], durationMs })
    check(!partial.ok && !('finalCues' in partial), '一条有效+一条非法时不产出部分结果')

    /* ── 规范化（previewHash 稳定性） ── */
    const chA = { kind: 'subtitle-text', cueId: c2.id, text: '甲' }
    const chB = { kind: 'subtitle-time', cueId: c1.id, startMs: 0, endMs: 1000 }
    const chS = { kind: 'subtitle-shift', cueIds: [c3.id, c2.id], deltaMs: 100 }
    const n1 = api.normalizeSubtitleChanges([chS, chA, chB] as never[], cues)
    const n2 = api.normalizeSubtitleChanges([chB, chA, chS] as never[], cues)
    check(JSON.stringify(n1) === JSON.stringify(n2), '乱序输入规范化后字节一致（同内容同指纹）')
    check(JSON.stringify((n1[2] as { cueIds: string[] }).cueIds) === JSON.stringify([c2.id, c3.id]), 'shift.cueIds 按 ordinal 稳定排序')
    check(api.normalizeSubtitleChanges([chA, chA] as never[], cues).length === 2, '规范化不去重（重复由 apply 冲突拒绝）')

    /* ── 全列表校验入口 ── */
    check(api.validateCueList(cues, durationMs) === null, '夹具通过全列表校验')
    check(api.validateCueList([{ ...c1, startMs: 12.5 } as SubtitleCueT, c2, c3], durationMs)?.code === 'invalid_time', '列表校验拒绝小数毫秒')
    check(api.validateCueList(cues, 6999)?.code === 'out_of_range', '时长基准变化立即暴露越界')
  }

  const runSnapshot = async (): Promise<void> => {
    const { cues, durationMs } = fixture()
    const sourceText = api.serializeSubtitleSrt(cues)
    const srcSha = api.sha256Text(sourceText)
    const tag = api.subtitleBaseTag(srcSha)

    /* ── 无平移（含严格路径证据：有效=源原样，不静默修正历史时码） ── */
    const snap = api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: null, sourceAssetId: 42, timingSource: 'unknown' })
    check(!!snap && snap.sha256 === srcSha, '无平移时快照 sha256 即源文本 hash')
    check(!!snap && snap.versionId === null && snap.coordinate === 'final' && snap.origin === 'source', '无人工修订：versionId 空 / coordinate final / origin source')
    check(!!snap && snap.cues.length === 3 && snap.cues.every((c, i) => c.id === api.makeCueId(tag, i + 1)), 'cue 标识锚定源基准 tag（与契约层同构）')
    check(!!snap && snap.cues[1]!.text === '第二句\n续行' && snap.cues[1]!.startMs === 3000, '多行中文与毫秒时间在快照中原样保留')
    check(!!snap && snap.sourceRef.assetId === 42 && snap.sourceRef.sha256 === srcSha && snap.sourceRef.timingSource === 'unknown', 'sourceRef 固定源资产/内容 hash/来源标记')
    check(!!snap && api.validateCueList(snap.cues, durationMs) === null, '快照 cue 过全列表校验（与成片时长界内）')

    /* ── 片头统移 1.5s（一句多 cue 文本随行保留） ── */
    const shifted = api.shiftSrtText(sourceText, [1.5, 1.5, 1.5])
    check(!!shifted, '片头统移 1.5s 产生有效文本')
    const snapShift = api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: shifted, sourceAssetId: 42, timingSource: 'measured' })
    check(!!snapShift && shifted !== null && snapShift.sha256 === api.sha256Text(shifted) && snapShift.sha256 !== srcSha, '平移后 sha256 指向有效文本而非源')
    check(!!snapShift && snapShift.cues.every((c, i) => c.id === api.makeCueId(tag, i + 1)), '平移不改 cue 基准（标识稳定）')
    check(!!snapShift && snapShift.cues[0]!.startMs === 1500 && snapShift.cues[2]!.endMs === 9500, 'final 轴时间已含片头平移')
    check(!!snapShift && snapShift.cues[1]!.text === '第二句\n续行', '平移不伤一句多 cue 文本')
    check(!!snapShift && snapShift.sourceRef.sha256 === srcSha, 'sourceRef 仍指源 hash（平移/人工不得升级来源）')
    // 含片头成片实长 = 内容 9s + 片头 1.5s，平移后末 cue 9500ms 界内
    check(!!snapShift && api.validateCueList(snapShift.cues, 10500) === null, '平移后快照过含片头成片时长校验')

    /* ── 逐句非均匀平移（命中句精确、未命中 cue 不动） ── */
    const alignShifted = api.shiftSrtText(sourceText, [0.2, 1, 0])
    const snapAlign = api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: alignShifted, sourceAssetId: 42, timingSource: 'estimated' })
    check(!!alignShifted && !!snapAlign && snapAlign.cues[0]!.startMs === 200 && snapAlign.cues[1]!.startMs === 4000 && snapAlign.cues[2]!.startMs === 6000, '逐句非均匀平移精确命中（Δ=0 cue 不动）')

    /* ── 关闭烧录：纯函数输出与烧录开关无关（开关只切断滤镜，快照仍可下载） ── */
    const snapNoBurn = api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: shifted, sourceAssetId: 42, timingSource: 'measured' })
    check(JSON.stringify(snapNoBurn) === JSON.stringify(snapShift), '关闭烧录时快照与烧录路径等价')

    /* ── 解析失败：省略字段而非伪快照/回退源 ── */
    check(api.buildEffectiveSubtitleSnapshot({ sourceText: '不是字幕', shiftedText: null, sourceAssetId: 1, timingSource: 'unknown' }) === null, '不可解析源 → null（调用方省略增量字段）')
    check(api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: '1\n垃圾时间戳\n甲', sourceAssetId: 1, timingSource: 'unknown' }) === null, '有效文本损坏 → null，不回退源文本')

    /* ── 人工修订接口预位（P3 接线点）：来源等级不升级 ── */
    const snapManual = api.buildEffectiveSubtitleSnapshot({ sourceText, shiftedText: null, sourceAssetId: 42, timingSource: 'measured', origin: 'manual', versionId: 77 })
    check(!!snapManual && snapManual.origin === 'manual' && snapManual.versionId === 77 && snapManual.sourceRef.timingSource === 'measured', '人工版本 origin/versionId 升级但 sourceRef 来源不升级')

    /* ── 共享唯一入口 planSubtitleShifts（烧录与快照同源；无 ffmpeg/无 IO） ── */
    const logs: string[] = []
    const sp = await api.planSubtitleShifts({ alignPlan: null, voiceLineIds: [], voiceCount: 3, introShift: 1.5, readSource: async () => sourceText, log: (m) => logs.push(m) })
    check(!!sp.shifts && sp.shifts.length === 3 && sp.shifts.every((d) => d === 1.5) && !sp.alignMode, '无对齐计划时按片头统移 1.5s 生成全量 shifts')
    check(sp.shiftedText === shifted, '入口平移结果与 shiftSrtText 直调一致（烧录/快照同源）')
    const spBad = await api.planSubtitleShifts({ alignPlan: null, voiceLineIds: [], voiceCount: 3, introShift: 1.5, readSource: async () => '不是字幕', log: (m) => logs.push(m) })
    check(spBad.shifts === null && spBad.shiftedText === null && logs.some((m) => m.includes('无有效 cue 行')), 'SRT 无有效 cue → 不统移不回退中断（原样有效）')
    const spZero = await api.planSubtitleShifts({ alignPlan: null, voiceLineIds: [], voiceCount: 3, introShift: 0.0005, readSource: async () => sourceText, log: (m) => logs.push(m) })
    check(!!spZero.shifts && spZero.shiftedText === null, 'Δ 全≈ 0 时不重写（有效文本即源）')

    /* ── planEffectiveSubtitle：有效文件路径规划（落盘由调用方执行） ── */
    const planShift = api.planEffectiveSubtitle({ sourceText, shiftedText: shifted, sourceRelPath: '42/texts/src.srt', sourceAssetId: 42, timingSource: 'measured' })
    check(!!planShift && planShift.effectiveTextToWrite === shifted, '发生平移时需另落有效文本')
    check(!!planShift && planShift.ext.effectiveRelPath.replace(/\\/g, '/').endsWith(`/display-${planShift.ext.sha256.slice(0, 16)}.srt`), '有效文件内容寻址命名与 sha 一致（不可变幂等）')
    const planPlain = api.planEffectiveSubtitle({ sourceText, shiftedText: null, sourceRelPath: '42/texts/src.srt', sourceAssetId: 42, timingSource: 'unknown' })
    check(!!planPlain && planPlain.effectiveTextToWrite === null && planPlain.ext.effectiveRelPath === '42/texts/src.srt', '无平移时有效文件即源文件（不另落盘）')
    check(api.planEffectiveSubtitle({ sourceText: '不是字幕', shiftedText: null, sourceRelPath: 'a.srt', sourceAssetId: 1, timingSource: 'unknown' }) === null, '不可解析时规划返回 null（调用方省略字段）')

    /* ── timeline 快照透传：v 不变，增量可选，旧形态兼容 ── */
    const tlBase = { fps: 25, width: 720, height: 1280, totalSec: 9, introSec: 0, outroSec: 0, segments: [], rows: [], alignPlan: null, voices: [], sfx: [], bgm: null, transition: null, watermark: false }
    const tlNew = api.buildEditTimeline({ ...tlBase, subtitle: { assetId: 42, relPath: '42/texts/src.srt', ...(snap as Omit<EffSnap, 'cues'>), cues: snap!.cues } })
    check(tlNew.v === 1 && Array.isArray(tlNew.subtitle?.cues) && (tlNew.subtitle?.cues as unknown[]).length === 3, 'timeline v=1 不变，subtitle 增量字段透传')
    check(tlNew.subtitle?.relPath === '42/texts/src.srt' && tlNew.subtitle?.origin === 'source', 'assetId/relPath 旧语义保留，新增字段共存')
    const tlOld = api.buildEditTimeline({ ...tlBase, subtitle: { assetId: 9, relPath: 'r.srt' } })
    check(tlOld.subtitle?.relPath === 'r.srt' && tlOld.subtitle.cues === undefined, '旧最小形态 subtitle 仍合法（增量全可选）')
    check(api.buildEditTimeline({ ...tlBase, subtitle: null }).subtitle === null, '无字幕形态不变')
  }

  const runLedger = async (): Promise<void> => {
    // 隔离库模式（probe-m26 同法）：isolatedEnv 后动态加载 db，initDb 走完整建表兜底链路
    const { initDb, db } = await import('../src/db')
    await initDb()
    const { pipelineRuns } = await import('../src/db/schema')
    const { eq } = await import('drizzle-orm')
    const { readFileSync } = await import('node:fs')
    const storage = await import('../src/services/storage')
    const ledger = await import('../src/services/rework/ledger')

    const { cues } = fixture()
    const sourceText = api.serializeSubtitleSrt(cues)
    const srcSha = api.sha256Text(sourceText)
    const editedText = api.serializeSubtitleSrt([{ ...cues[0]!, text: '改后第一句' }, cues[1]!, cues[2]!])
    const runRows = await db
      .insert(pipelineRuns)
      .values({
        projectId: 91,
        templateKey: 'probe-rework',
        input: JSON.stringify({ _compose: { subtitleBurn: false } }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning()
    const run = runRows[0]!

    /* ── 幂等台账（§5.1）：同键同载荷回放、异载荷冲突 ── */
    const base = { projectId: 91, runId: run.id, stepKey: 'compose', requestKey: 'req-1', requestHash: 'hash-a', baseFingerprint: 'fp-base' }
    const c1 = await ledger.upsertReworkRequest(base)
    check(c1.outcome === 'created' && c1.row.state === 'parsing' && c1.row.resultJson === '{}' && c1.row.sessionId === null, '首次请求登记 created/parsing，回执缺省空')
    const r2 = await ledger.upsertReworkRequest({ ...base, changes: [{ kind: 'subtitle-text' }] })
    check(r2.outcome === 'replayed' && r2.row.id === c1.row.id && r2.row.changesJson === '[]', '同键同载荷回放既有行（载荷不重复写入）')
    const c3 = await ledger.upsertReworkRequest({ ...base, requestHash: 'hash-b' })
    check(c3.outcome === 'conflict' && c3.row.id === c1.row.id && c3.row.requestHash === 'hash-a', '同键异载荷冲突且原行不被改写（routes 层 409 语义）')
    const c4 = await ledger.upsertReworkRequest({ ...base, requestKey: 'req-2' })
    check(c4.outcome === 'created' && c4.row.id !== c1.row.id, '同 run 不同 requestKey 独立登记')

    /* ── 状态转换：applied 终态回执固定 ── */
    const ready = await ledger.advanceReworkRequestState(c1.row.id, 'ready', { preview: { previewHash: 'pv-1' } })
    check(ready.state === 'ready' && (JSON.parse(ready.previewJson) as { previewHash: string }).previewHash === 'pv-1', 'parsing→ready 携带固定预览写入')
    const applied = await ledger.advanceReworkRequestState(c1.row.id, 'applied', { result: { versionId: 5 } })
    check(applied.state === 'applied' && (JSON.parse(applied.resultJson) as { versionId: number }).versionId === 5, 'ready→applied 回执固定')
    const replay = await ledger.advanceReworkRequestState(c1.row.id, 'applied', { result: { versionId: 999 } })
    check(replay.state === 'applied' && (JSON.parse(replay.resultJson) as { versionId: number }).versionId === 5, '重复确认返回原回执（result 不被覆盖）')
    let terminalCode = ''
    try {
      await ledger.advanceReworkRequestState(c1.row.id, 'ready')
    } catch (err) {
      terminalCode = (err as { code?: string }).code ?? ''
    }
    check(terminalCode === 'terminal_state', '离开 applied 终态拒绝')

    /* ── 显示字幕版本链（§5.2）：源不动、不可变文件、meta 消毒 ── */
    const v1 = await ledger.recordSubtitleDisplayVersion({
      projectId: 91,
      runId: run.id,
      stepKey: 'compose',
      content: sourceText,
      source: 'baseline',
      label: '初始有效内容',
      meta: { sourceSubtitleId: 42, sourceSha256: srcSha, baseFinalId: 7, baseFingerprint: 'fp-base', parentVersionId: null, requestId: null, cueIds: cues.map((c) => c.id), changeSummary: '', validationHash: 'ASR-不得入库' },
    })
    check(v1.version.revision === 1 && v1.asset.purpose === 'subtitle_display' && v1.asset.runId === run.id && v1.asset.id !== 42, '首版 baseline 登记独立显示资产（原 subtitle 资产不复用）')
    const meta1 = JSON.parse(v1.version.meta) as Record<string, unknown>
    check(!('validationHash' in meta1) && meta1['sourceSubtitleId'] === 42 && Array.isArray(meta1['cueIds']) && (meta1['cueIds'] as string[]).length === 3, 'meta 白名单消毒：ASR validationHash 永不入库')
    const v1FileAbs = storage.absPathOf(v1.version.relPath!)
    const v2 = await ledger.recordSubtitleDisplayVersion({
      projectId: 91,
      runId: run.id,
      stepKey: 'compose',
      content: editedText,
      source: 'edit',
      label: '人工修订',
      meta: { sourceSubtitleId: 42, sourceSha256: srcSha, baseFinalId: 7, baseFingerprint: 'fp-base', parentVersionId: v1.version.id, requestId: c1.row.id, cueIds: [cues[0]!.id], changeSummary: '1 条 cue 改文字' },
    })
    check(v2.version.revision === 2 && v2.version.sha256 === api.sha256Text(editedText), '人工修订版 rev=2，hash 指向新内容')
    check(v2.version.relPath !== v1.version.relPath && readFileSync(v1FileAbs, 'utf8') === sourceText, '每版独立不可变文件：旧文件不被新版覆写')
    check(readFileSync(storage.absPathOf(v2.asset.relPath!), 'utf8') === editedText, '逻辑资产工作副本指向当前版本')
    const again = await ledger.ensureSubtitleDisplayAsset({ projectId: 91, runId: run.id, stepKey: 'compose', initialContent: '不得覆写' })
    check(again.id === v2.asset.id && readFileSync(storage.absPathOf(again.relPath!), 'utf8') === editedText, '显示资产每 run+step 一份幂等复用（不重置工作副本）')
    const v3 = await ledger.recordSubtitleDisplayVersion({ projectId: 91, runId: run.id, stepKey: 'compose', content: sourceText, source: 'edit', meta: {} })
    check(v3.version.revision === 3 && v3.version.sha256 === srcSha, '恢复旧内容=生成新修订（不倒写历史）')

    /* ── run.input._subtitleEdits 受控键：专用通道直写，保留其它键 ── */
    check(Object.keys(await ledger.readSubtitleEdits(run.id)).length === 0, '缺省无 _subtitleEdits 时读空表')
    await ledger.writeSubtitleEdit(run.id, 'compose', { assetId: v2.asset.id, versionId: v3.version.id, sha256: v3.version.sha256!, baseFingerprint: 'fp-base', requestId: c1.row.id })
    const edits = await ledger.readSubtitleEdits(run.id)
    check(edits['compose']?.assetId === v2.asset.id && edits['compose']?.versionId === v3.version.id, '_subtitleEdits 写入后固定版本指针往返一致')
    const rawInput = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).limit(1))[0]!.input
    const parsedInput = JSON.parse(rawInput) as { _compose?: { subtitleBurn?: boolean }; _subtitleEdits?: Record<string, unknown> }
    check(parsedInput._compose?.subtitleBurn === false && Object.keys(parsedInput._subtitleEdits ?? {}).length === 1, '专用通道只 merge 目标键：_compose 等既有 input 内容不丢')
    check(Object.keys(ledger.parseSubtitleEdits('不是 JSON')).length === 0 && Object.keys(ledger.parseSubtitleEdits(JSON.stringify({ _subtitleEdits: { x: { assetId: 1 } } }))).length === 0, '损坏/字段不全条目容错降级为空（合成期不中断）')
  }

  const runPreview = async (): Promise<void> => {
    const tools = await createFixtureTools(92)
    const { db, pipelineRuns, pipelineSteps, assets, genTasks, now, mkRun, mkFixture } = tools
    const { eq: eqP } = await import('drizzle-orm')
    const preview = await import('../src/services/rework/preview')
    const ledger = await import('../src/services/rework/ledger')
    const { cues, durationMs, sourceText, srcSha } = tools

    /* ── 能力判定与指纹 ── */
    const runId = await mkRun('completed')
    const fix1 = await mkFixture(runId)
    const baselineMod = await import('../src/services/rework/baseline')
    const as1 = await baselineMod.assessSubtitleCapability(runId, 'compose')
    check(as1.capability.supported && as1.baseline !== null && as1.baseline!.cues.length === 3, '健康成片：能力支持且基准 cues 来自有效快照')
    check(!!as1.baseline && as1.baseline.origin === 'source' && as1.baseline.sourceRef.timingSource === 'measured' && as1.baseline.currentEdit === null, '首次基准：origin=source，来源等级透传，无人工修订指针')
    const as2 = await baselineMod.assessSubtitleCapability(runId, 'compose')
    check(!!as1.baseline && !!as2.baseline && as1.baseline.fingerprint === as2.baseline.fingerprint, '同一依赖两次指纹一致（可重复比较）')

    /* ── 拦断面：在途/缺快照/损坏/范围外失败/下游付费/受理不确定/缺 run ── */
    const activeRun = await mkRun('running')
    await mkFixture(activeRun)
    check((await baselineMod.assessSubtitleCapability(activeRun, 'compose')).capability.code === 'run_active', '运行在途不能确认')
    const legacyRun = await mkRun('completed')
    await mkFixture(legacyRun, { stripTimeline: true })
    check((await baselineMod.assessSubtitleCapability(legacyRun, 'compose')).capability.code === 'legacy_no_snapshot', '旧成片缺快照：只读提示先建立基准，不自动执行')
    const corruptRun = await mkRun('completed')
    await mkFixture(corruptRun, { corruptSnap: true })
    check((await baselineMod.assessSubtitleCapability(corruptRun, 'compose')).capability.code === 'corrupt_snapshot', '快照字段损坏明确拒绝（不回退台词生成字幕）')
    const badRun = await mkRun('completed')
    await mkFixture(badRun)
    await db.insert(pipelineSteps).values({ runId: badRun, seq: 3, stepKey: 'pub', actionKey: 'publication_ingest', status: 'failed', output: '{}', attempts: 1, createdAt: now, updatedAt: now })
    check((await baselineMod.assessSubtitleCapability(badRun, 'compose')).capability.code === 'other_failed', '范围外失败步骤拦断')
    const paidRun = await mkRun('completed')
    await mkFixture(paidRun)
    await db.insert(pipelineSteps).values({ runId: paidRun, seq: 3, stepKey: 'more', actionKey: 'ai_video', status: 'pending', output: null, attempts: 0, createdAt: now, updatedAt: now })
    check((await baselineMod.assessSubtitleCapability(paidRun, 'compose')).capability.code === 'downstream_paid', '下游待执行付费链不能确认')
    const uncRun = await mkRun('completed')
    await mkFixture(uncRun)
    await db.insert(genTasks).values({ projectId: 92, runId: uncRun, stepId: 0, kind: 'video', params: '{}', status: 'failed', attempts: 1, createdAt: now, updatedAt: now })
    check((await baselineMod.assessSubtitleCapability(uncRun, 'compose')).capability.code === 'uncertain_tasks', '受理不确定任务拦断（需先人工核对）')
    check((await baselineMod.assessSubtitleCapability(999999, 'compose')).capability.code === 'run_not_found', '不存在的 run 拒绝（跨项目/乱 id 入口统一 fail closed）')

    /* ── 结构化预览：就绪/幂等/冲突/无效回执 ── */
    // 快照存储的 cue 标识以源文本 hash 基准 tag 锚定，与夹具虚构 tag 不同——以 baseline 返回为准
    const baseCues = as1.baseline!.cues
    const c1 = baseCues[0]!
    const changes = [{ kind: 'subtitle-text', cueId: c1.id, text: '新第一句' }]
    const p1 = await preview.buildSubtitlePreview({ runId, requestKey: 'pv-1', changes })
    check(p1.outcome === 'ready' && 'preview' in p1 && p1.preview.diffs.length === 1 && p1.preview.finalCues[0]!.text === '新第一句' && JSON.stringify(p1.preview.finalCues[2]) === JSON.stringify(baseCues[2]), '单 cue 文字修改预览：只改目标 cue，diff 精确')
    check('preview' in p1 && /^([0-9a-f]{64})$/.test(p1.preview.previewHash) && p1.preview.impact.modelCalls === 0 && p1.preview.impact.localOnly === true, '预览固定 previewHash 与零模型调用影响声明')
    check('preview' in p1 && p1.preview.impact.newReviewRequired === true && p1.preview.effectiveSha256 === api.sha256Text(api.serializeSubtitleSrt(p1.preview.finalCues)), '新版本需复审；有效文本 hash 与序列化结果同源')
    const p2 = await preview.buildSubtitlePreview({ runId, requestKey: 'pv-1', changes })
    check(p2.outcome === 'replayed' && 'requestId' in p2 && p2.requestId === (p1 as { requestId: string }).requestId, '同键同载荷回放既有预览（不新建行）')
    const p3 = await preview.buildSubtitlePreview({ runId, requestKey: 'pv-1', changes: [{ kind: 'subtitle-text', cueId: c1.id, text: '另一个值' }] })
    check(p3.outcome === 'conflict' && p3.code === 'idempotency_conflict', '同键异载荷冲突（routes 层 409）')
    const pBad = await preview.buildSubtitlePreview({ runId, requestKey: 'pv-bad', changes: [{ kind: 'subtitle-text', cueId: 'srt:deadbeef:c9', text: '甲' }] })
    check(pBad.outcome === 'blocked' && pBad.code === 'unknown_cue' && !!pBad.requestId, '无效变更也登记可回放 blocked 回执')
    const view = await preview.getReworkRequestView(pBad.requestId!)
    check(view.state === 'blocked' && (view.preview as { errors?: unknown[] }).errors !== undefined, '请求状态 GET 回放：无副作用纯读取')

    /* ── 预览零执行态写入：run/step/task 全部不动 ── */
    const runRow = (await db.select().from(pipelineRuns).where(eqP(pipelineRuns.id, runId)).limit(1))[0]!
    check(runRow.status === 'completed' && runRow.input === '{}', '预览不改 run 状态/input')
    const stepRows = await db.select().from(pipelineSteps).where(eqP(pipelineSteps.runId, runId))
    check(stepRows.every((s) => s.status === 'succeeded') && stepRows.length === 2, '预览不重置任何步骤')
    const taskRows = await db.select().from(genTasks).where(eqP(genTasks.runId, runId))
    check(taskRows.length === 0, '预览不创建/不重置生成任务')

    /* ── 人工修订链：写指针后基准切换，指纹漂移，预览在新基准上叠加 ── */
    let fpLatest = as1.baseline!.fingerprint
    if (p1.outcome === 'ready') {
      const editedSrt = api.serializeSubtitleSrt(p1.preview.finalCues)
      const v = await ledger.recordSubtitleDisplayVersion({ projectId: 92, runId, stepKey: 'compose', content: editedSrt, source: 'edit', meta: { cueIds: [c1.id], changeSummary: '1 条改文字' } })
      const fpBefore = as1.baseline!.fingerprint
      await ledger.writeSubtitleEdit(runId, 'compose', { assetId: v.asset.id, versionId: v.version.id, sha256: v.version.sha256!, baseFingerprint: fpBefore, requestId: p1.requestId })
      const as3 = await baselineMod.assessSubtitleCapability(runId, 'compose')
      check(!!as3.baseline && as3.baseline.origin === 'manual' && as3.baseline.cues[0]!.text === '新第一句', '人工修订指针生效后基准切到修订版本内容')
      check(!!as3.baseline && as3.baseline.fingerprint !== fpBefore, '修订指针纳入依赖指纹（旧预览基自动失效）')
      if (as3.baseline) fpLatest = as3.baseline.fingerprint
      const pCueId = as3.baseline?.cues[2]?.id ?? baseCues[2]!.id
      const p4 = await preview.buildSubtitlePreview({ runId, requestKey: 'pv-2', changes: [{ kind: 'subtitle-text', cueId: pCueId, text: '第三句再改' }] })
      check(p4.outcome === 'ready' && 'preview' in p4 && p4.preview.baseCues[0]!.text === '新第一句' && p4.preview.finalCues[2]!.text === '第三句再改', '在人工修订基准上叠加新预览（历史不倒写）')
    }

    /* ── 媒体重做/成片替换使指纹漂移（同 run 重读） ── */
    await db.update(assets).set({ sha256: 'final-sha-2', updatedAt: Date.now() }).where(eqP(assets.id, fix1.finalId))
    const as4 = await baselineMod.assessSubtitleCapability(runId, 'compose')
    check(!!as4.baseline && as4.baseline.fingerprint !== fpLatest, '成片内容 hash 变更（媒体重做）→ 依赖指纹漂移，旧预览作废')
  }

  const runApply = async (): Promise<void> => {
    const tools = await createFixtureTools(92)
    const { db, pipelineRuns, pipelineSteps, assets, now, srcSha, mkRun, mkFixture } = tools
    const { eq, and } = await import('drizzle-orm')
    const preview = await import('../src/services/rework/preview')
    const apply = await import('../src/services/rework/apply')
    const baselineMod = await import('../src/services/rework/baseline')
    const { readVersionContent, currentRevision } = await import('../src/services/provenance')
    const engineMod = await import('../src/pipeline/engine')
    // 引擎 stub：提交后只记录启动调用，零真实执行（探针无真媒体文件）。
    // 不还原：runChain finally 每轮 void pumpGlobal，队列里有 queued run 时若恢复真方法会陷入
    // 「泵起→模板缺失→仍 queued」无限循环（探针进程内不应有后台泵，永久 no-op 才能断燃料）
    const started: number[] = []
    engineMod.engine.startRun = ((runId: number) => { started.push(runId); return 'started' }) as typeof engineMod.engine.startRun
    engineMod.engine.pumpGlobal = (async () => {}) as typeof engineMod.engine.pumpGlobal
    {
      /* ── 主链：错误 hash 拒绝（零副作用）→ 正确应用 → 回执回放不二次推进 ── */
      const runA = await mkRun('completed')
      const fixA = await mkFixture(runA)
      // 预设旧终审批 gate + 受控 _compose 键（验证作废与 merge 保留）
      await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: [fixA.finalId], gate: { decision: 'approve', at: now } }) }).where(eq(pipelineSteps.id, fixA.composeId))
      await db.update(pipelineRuns).set({ input: JSON.stringify({ _compose: { subtitleBurn: true } }) }).where(eq(pipelineRuns.id, runA))
      const asA = await baselineMod.assessSubtitleCapability(runA, 'compose')
      const cueId = asA.baseline!.cues[0]!.id
      const pvA = await preview.buildSubtitlePreview({ runId: runA, requestKey: 'ap-1', changes: [{ kind: 'subtitle-text', cueId, text: '新第一句' }] })
      check(pvA.outcome === 'ready' && 'preview' in pvA, '应用前置：预览就绪（基座夹具与台账同库）')
      const previewHash = pvA.outcome === 'ready' ? pvA.preview.previewHash : ''
      const rWrong = await apply.applySubtitleRework({ requestId: pvA.requestId!, previewHash: '0'.repeat(64) })
      const runAfterWrong = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runA)).limit(1))[0]!
      const stepAfterWrong = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, fixA.composeId)).limit(1))[0]!
      check(rWrong.outcome === 'rejected' && rWrong.code === 'stale_preview' && runAfterWrong.status === 'completed' && stepAfterWrong.status === 'succeeded', 'previewHash 不符拒绝：零状态变化（run/步骤均原样）')
      const r1 = await apply.applySubtitleRework({ requestId: pvA.requestId!, previewHash })
      type Rc = { sha256: string; revision: number; versionId: number; assetId: number }
      const rc1 = (r1 as { outcome: string; result?: Rc }).result!
      check(r1.outcome === 'applied' && rc1.sha256 === (pvA as { preview: { effectiveSha256: string } }).preview.effectiveSha256 && rc1.revision === 1, '确认应用：回执固定版本 hash 与首修订号')
      check(started.length === 1 && started[0] === runA, '事务提交后才启动现有引擎（本 run 一次）')
      const runRowA = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runA)).limit(1))[0]!
      const inputA = JSON.parse(runRowA.input) as { _compose?: { subtitleBurn?: boolean }; _subtitleEdits?: Record<string, { versionId?: number; sha256?: string; baseFingerprint?: string }> }
      const stepRowA = (await db.select().from(pipelineSteps).where(eq(pipelineSteps.id, fixA.composeId)).limit(1))[0]!
      const outA = JSON.parse(stepRowA.output ?? '{}') as { asset_ids?: number[]; gate?: unknown }
      check(runRowA.status === 'queued' && inputA._compose?.subtitleBurn === true, '入队且受控键 merge 保留：_compose 不丢（专用通道只改目标键）')
      check(inputA._subtitleEdits?.['compose']?.versionId === rc1.versionId && inputA._subtitleEdits?.['compose']?.sha256 === rc1.sha256, '当前指针同事务切换到新修订版本')
      check(stepRowA.status === 'pending' && outA.gate === undefined && Array.isArray(outA.asset_ids), '旧终审批 gate 作废（新版本必复审），历史产物保留')
      const verContent = await readVersionContent(rc1.versionId)
      const verText = verContent.kind === 'text' ? verContent.text : ''
      const verParsed = api.parseSubtitleSrt(verText)
      check(verContent.kind === 'text' && api.sha256Text(verText) === rc1.sha256 && verParsed.ok && verParsed.cues[0]!.text === '新第一句', '版本文件内容不可变且与回执 hash 一致')
      const srcRow = (await db.select().from(assets).where(eq(assets.id, fixA.srcId)).limit(1))[0]!
      const finRow = (await db.select().from(assets).where(eq(assets.id, fixA.finalId)).limit(1))[0]!
      check(srcRow.sha256 === srcSha && finRow.sha256 === 'final-sha-1', '源字幕与成片资产零改写')
      const r2 = await apply.applySubtitleRework({ requestId: pvA.requestId!, previewHash })
      const revNow = await currentRevision('asset', rc1.assetId)
      check(r2.outcome === 'replayed' && JSON.stringify((r2 as { result?: Rc }).result) === JSON.stringify(rc1) && revNow === 1 && started.length === 1, 'applied 回放：回执幂等可回放，不二次建版本/不重复启动')

      /* ── 非 ready 拒绝：blocked 回执不可确认 ── */
      const runB = await mkRun('completed')
      await mkFixture(runB)
      const pvBad = await preview.buildSubtitlePreview({ runId: runB, requestKey: 'ap-bad', changes: [{ kind: 'subtitle-text', cueId: 'srt:deadbeef:c9', text: '甲' }] })
      const rBad = await apply.applySubtitleRework({ requestId: pvBad.requestId!, previewHash: 'f'.repeat(64) })
      check(pvBad.outcome === 'blocked' && rBad.outcome === 'rejected' && rBad.code === 'not_ready', 'blocked 请求不可确认（必须先有效预览）')

      /* ── 依赖漂移：预览后就地改媒体→ apply 重验指纹拒 stale_preview且不重置 ── */
      const runC = await mkRun('completed')
      const fixC = await mkFixture(runC)
      const asC = await baselineMod.assessSubtitleCapability(runC, 'compose')
      const pvC = await preview.buildSubtitlePreview({ runId: runC, requestKey: 'ap-c', changes: [{ kind: 'subtitle-text', cueId: asC.baseline!.cues[0]!.id, text: '漂移前' }] })
      await db.update(assets).set({ sha256: 'final-sha-drift', updatedAt: Date.now() }).where(eq(assets.id, fixC.finalId))
      const rDrift = await apply.applySubtitleRework({ requestId: pvC.requestId!, previewHash: (pvC as { preview: { previewHash: string } }).preview.previewHash })
      const runRowC = (await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runC)).limit(1))[0]!
      check(rDrift.outcome === 'rejected' && rDrift.code === 'stale_preview' && runRowC.status === 'completed', '预览后媒体重做 → 确认期指纹重验拦断（不套用到新基准）')

      /* ── 只应用一次：条件领用原子互斥（真并发单语句）+ 二次确认回放同回执 ── */
      // libsql 单 client 不允许两个 db.transaction 交错（同连接事务互斥 BUSY），并发语义分两层钉死：
      // ① apply 串行双发：赢家 applied、输家见 applied 回执回放，版本链仅 +1；
      // ② 事务内同款条件 UPDATE 真并发：ready→applied 翻转只有一方拿到
      const runD = await mkRun('completed')
      await mkFixture(runD)
      const asD = await baselineMod.assessSubtitleCapability(runD, 'compose')
      const pvD = await preview.buildSubtitlePreview({ runId: runD, requestKey: 'ap-d', changes: [{ kind: 'subtitle-shift', cueIds: [asD.baseline!.cues[0]!.id, asD.baseline!.cues[2]!.id], deltaMs: 200 }] })
      const hashD = (pvD as { preview: { previewHash: string } }).preview.previewHash
      const rD1 = await apply.applySubtitleRework({ requestId: pvD.requestId!, previewHash: hashD })
      const rD2 = await apply.applySubtitleRework({ requestId: pvD.requestId!, previewHash: hashD })
      const revD = rD1.outcome === 'applied' ? await currentRevision('asset', rD1.result.assetId) : -1
      check(rD1.outcome === 'applied' && rD2.outcome === 'replayed' && JSON.stringify((rD2 as { result?: Rc }).result) === JSON.stringify((rD1 as { result?: Rc }).result) && revD === 1, '双发确认只应用一次：输家回放同回执且版本链仅 +1')
      const { reworkRequests } = await import('../src/db/schema')
      // 竞争行另建夹具：runD 应用后已入队（run_active 拦断新预览，属产品正确语义），不可在其上叠加
      const runE = await mkRun('completed')
      await mkFixture(runE)
      const asE = await baselineMod.assessSubtitleCapability(runE, 'compose')
      const pvE = await preview.buildSubtitlePreview({ runId: runE, requestKey: 'ap-e', changes: [{ kind: 'subtitle-text', cueId: asE.baseline!.cues[1]!.id, text: '领用竞争行' }] })
      check(pvE.outcome === 'ready', '领用竞争行预览就绪')
      const claimRace = await Promise.all([
        db.update(reworkRequests).set({ state: 'applied' }).where(and(eq(reworkRequests.id, pvE.requestId!), eq(reworkRequests.state, 'ready'))).returning(),
        db.update(reworkRequests).set({ state: 'applied' }).where(and(eq(reworkRequests.id, pvE.requestId!), eq(reworkRequests.state, 'ready'))).returning(),
      ])
      check(claimRace[0]!.length + claimRace[1]!.length === 1, '条件 UPDATE 原子互斥：真并发下 ready→applied 只有单一赢家')
      check(started.length === 2, '赢家启动一次；回放方不重复启动（本分节共启动 runA+runD）')
    }
  }

  await runSections({
    log,
    title: 'precision-rework',
    checker,
    sections: SECTIONS,
    runners: { contract: runContract, snapshot: runSnapshot, ledger: runLedger, preview: runPreview, apply: runApply, compose: () => runComposeSection(check), 'compose-input': () => runComposeInputSection(check), 'shot-duration': () => runShotDurationSection(check), stale: () => runStaleSection(check), projection: () => runProjectionSection(check), exchange: () => runExchangeSection(check), parse: () => runParseSection(check) },
    cleanup,
  })
}

void main()
