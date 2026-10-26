/**
 * M66 探针（AIGC 合规标识）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m66.ts [--section=pure|remux|brand|compose-args|wiring|implicit|export]
 *
 * 隔离策略：isolatedEnv('m66') 一次性临时目录（独立 studio.db + workspace），
 * 必须先于任何 src 动态 import。零网络零付费：ffmpeg 用内置二进制处理本地小样。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup } = isolatedEnv('m66')

const SECTIONS = ['pure', 'remux', 'brand', 'compose-args', 'wiring', 'implicit', 'export'] as const

// —— 黄金基线（Task-4 Step 1：args.ts 修改前以临时脚本 tmp-golden-m66.ts 实测固化，脚本已删除）——
// fixture：segments [image 2s, video 3s]，1280x720@30，无转场/配音/BGM/水印/片头尾/字幕（与 compose-args 节 base 常量一致）。
const GOLDEN_ARGS =
  '["-y","-loop","1","-t","2","-i","a.png","-i","b.mp4","-filter_complex","[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,format=yuv420p[v0];[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,format=yuv420p[v1];[v0][v1]concat=n=2:v=1:a=0[basev]","-map","[basev]","-c:v","libx264","-preset","medium","-crf","20","-r","30","-movflags","+faststart","/tmp/out.mp4"]'
// cwd 行实测输出为 JSON.stringify(undefined)（无字幕 → cwd 缺省）→ 以 undefined 值直接比对
const GOLDEN_CWD: string | undefined = undefined

const { createLogger } = await import('../src/logger')
const log = createLogger('probe-m66')
const checker: Checker = makeChecker(log)
const check = checker.check

await runSections({
  log, title: 'M66', checker, cleanup, sections: SECTIONS,
  registry: async () => {
    const { initDb } = await import('../src/db')
    await initDb()
    check(true, '初始化隔离库完成')
  },
  runners: {
    pure: async () => {
      const { aigcMetadata, insertPngText, insertJpegApp1, AIGC_META_KEY } = await import('../src/services/compliance-label')
      const { crc32 } = await import('node:zlib')

      // —— aigcMetadata：六字段与取值 ——
      const m1 = aigcMetadata({ producer: '测试工作室' })
      const meta1 = JSON.parse(m1.json) as Record<string, string>
      check(Object.keys(meta1).length === 6, '元数据恰为六个字段')
      check(meta1['Label'] === '1', 'Label 固定为 1')
      check(meta1['ContentProducer'] === '测试工作室', 'ContentProducer 透传')
      check(typeof meta1['ProduceID'] === 'string' && meta1['ProduceID'].length === 36, 'ProduceID 为 UUID')
      check(meta1['ReservedCode1'] === '', 'ReservedCode1 缺省空串')
      check(meta1['ContentPropagator'] === '' && meta1['PropagateID'] === '', '传播者字段生成阶段为空')
      const m2 = aigcMetadata({ producer: '测试工作室', contentPropagator: '发行方A', propagateId: 'pid-1' })
      const meta2 = JSON.parse(m2.json) as Record<string, string>
      check(meta2['ContentPropagator'] === '发行方A' && meta2['PropagateID'] === 'pid-1', '传播者字段发布环节可填')
      check(m2.produceId !== m1.produceId, '每次调用 ProduceID 唯一')

      // —— PNG tEXt ——
      // 最小合法 PNG：签名 + IHDR(13B) + IDAT(4B) + IEND（手工构造，结构合法即可）
      const chunk = (type: string, data: Buffer): Buffer => {
        const c = Buffer.alloc(12 + data.length)
        c.writeUInt32BE(data.length, 0); c.write(type, 4, 'latin1'); data.copy(c, 8)
        return c
      }
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', Buffer.alloc(13)),
        chunk('IDAT', Buffer.from([1, 2, 3, 4])),
        chunk('IEND', Buffer.alloc(0)),
      ])
      const json = m1.json
      const labeled = insertPngText(png, json)
      check(!!labeled, 'PNG tEXt 插入成功')
      const out = labeled!
      check(out.length === png.length + 12 + 5 + Buffer.byteLength(json), 'PNG 插入后长度恰增一个 tEXt 块')
      check(out.subarray(0, 8).equals(png.subarray(0, 8)) && out.readUInt32BE(8) === 13, '签名与 IHDR 未动')
      const tOff = 8 + 8 + 13 + 4
      check(out.readUInt32BE(tOff) === 5 + Buffer.byteLength(json), 'tEXt 数据长度正确')
      check(out.subarray(tOff + 4, tOff + 8).toString('latin1') === 'tEXt', '块类型为 tEXt')
      check(out.subarray(tOff + 8, tOff + 13).toString('latin1') === `${AIGC_META_KEY}\0`, 'keyword 为 AIGC\\0')
      check(out.subarray(tOff + 13).subarray(0, Buffer.byteLength(json)).toString('utf8') === json, 'tEXt 值为完整 JSON')
      check(out.subarray(out.length - 12).equals(png.subarray(png.length - 12)), '尾部 IEND 原样保留')
      const dataLen = out.readUInt32BE(tOff)
      const crcEnd = tOff + 8 + dataLen
      check(out.readUInt32BE(crcEnd) === crc32(out.subarray(tOff + 4, crcEnd)), 'tEXt CRC 与 zlib.crc32 计算一致')
      check(insertPngText(Buffer.from('notpng'), json) === null, '非 PNG 输入返回 null')

      // —— JPEG APP1 ——
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), ...Buffer.alloc(11)]),
        Buffer.from([0xff, 0xd9]),
      ])
      const j1 = insertJpegApp1(jpeg, json)
      check(!!j1, 'JPEG APP1 插入成功')
      const jo = j1!
      check(jo[0] === 0xff && jo[1] === 0xd8, 'SOI 保留在头')
      check(jo[2] === 0xff && jo[3] === 0xe0, 'JFIF APP0 仍在 APP1 之前')
      let off = 2 + 2 + jo.readUInt16BE(4)
      check(jo[off] === 0xff && jo[off + 1] === 0xe1, 'AIGC APP1 段位于 APP0 之后')
      const segLen = jo.readUInt16BE(off + 2)
      check(segLen === 2 + 5 + Buffer.byteLength(json), 'APP1 长度字段 = 2 + payload')
      check(jo.subarray(off + 4, off + 9).toString('latin1') === `${AIGC_META_KEY}\0`, 'APP1 标识为 AIGC\\0')
      check(jo.subarray(off + 9, off + 9 + Buffer.byteLength(json)).toString('utf8') === json, 'APP1 载荷为完整 JSON')
      check(jo.subarray(jo.length - 2).equals(Buffer.from([0xff, 0xd9])), 'EOI 保留在尾')
      check(insertJpegApp1(Buffer.from([0x00, 0x01, 0x02]), json) === null, '非 SOI 输入返回 null')
      const bigJson = JSON.stringify({ padding: 'x'.repeat(66 * 1024) })
      check(insertJpegApp1(jpeg, bigJson) === null, 'APP1 载荷超 64KB 返回 null')
    },
    remux: async () => {
      const { applyImplicitLabel } = await import('../src/services/compliance-label')
      const { resolveFfmpeg, resolveFfprobe } = await import('../src/services/ffmpeg')
      const { execFileSync } = await import('node:child_process')
      const { mkdtempSync, readFileSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')

      const ffmpeg = resolveFfmpeg()
      check(!!ffmpeg, '内置 ffmpeg 可用')
      const dir = mkdtempSync(join(tmpdir(), 'm66-remux-'))

      // 小样制作（1s）：mp4（color 源）、mp3（sine 源）、png（单帧图像）
      const mp4 = join(dir, 'a.mp4')
      execFileSync(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-pix_fmt', 'yuv420p', mp4], { stdio: 'ignore' })
      const mp3 = join(dir, 'a.mp3')
      execFileSync(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-q:a', '9', mp3], { stdio: 'ignore' })
      const png = join(dir, 'a.png')
      execFileSync(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', png], { stdio: 'ignore' })

      const readTag = (file: string, probeBin: string): string | null => {
        try {
          const r = execFileSync(probeBin, ['-v', 'error', '-show_entries', 'format_tags=AIGC', '-of', 'json', file], { encoding: 'utf8' })
          const doc = JSON.parse(r) as { format?: { tags?: Record<string, string> } }
          return doc.format?.tags?.['AIGC'] ?? null
        } catch { return null }
      }

      // mp4 重封装后 tag 可读且六字段正确
      const r1 = await applyImplicitLabel(mp4, 'mp4', { producer: '测试工作室' })
      check(r1.ok && !!r1.produceId, 'mp4 隐式标识写入成功')
      const tag1 = readTag(mp4, resolveFfprobe()!)
      check(!!tag1, 'mp4 format_tags 可读回 AIGC')
      const meta1 = JSON.parse(tag1!) as Record<string, string>
      check(meta1['Label'] === '1' && meta1['ContentProducer'] === '测试工作室' && !!meta1['ProduceID'], 'mp4 六字段内容正确')
      check(readTag(mp4, resolveFfprobe()!) === tag1, '重封装幂等（内容流未变仅元数据）')

      // mp3 同律
      const r2 = await applyImplicitLabel(mp3, 'mp3', { producer: '测试工作室' })
      check(r2.ok, 'mp3 隐式标识写入成功')
      const tag2 = readTag(mp3, resolveFfprobe()!)
      check(!!tag2 && (JSON.parse(tag2!) as Record<string, string>)['Label'] === '1', 'mp3 AIGC tag 可读')

      // png 走纯 Node 通道后仍为合法 PNG 且可被 ffprobe 读取
      const r3 = await applyImplicitLabel(png, 'png', { producer: '测试工作室' })
      check(r3.ok, 'png 隐式标识写入成功')
      check(readFileSync(png).readUInt32BE(0) === 0x89504e47, 'png 签名完好')
      const probePng = readTag(png, resolveFfprobe()!)
      check(probePng === null || (JSON.parse(probePng!) as Record<string, string>)['Label'] === '1', 'png 容器读回兼容（tEXt 不破坏解析）')

      // 失败旁路：不存在的扩展名
      const r4 = await applyImplicitLabel(mp4, 'xyz', { producer: 'x' })
      check(!r4.ok && !!r4.error, '不支持扩展名返回 ok:false 不抛异常')
    },
    brand: async () => {
      const bc = await import('../src/services/brand-config')

      // 缺省即开（M66 用户决策）
      const d = bc.sanitizeCompliance(undefined)
      check(d.enabled === true, 'compliance 缺省 enabled=true')
      check(d.text === 'AI生成', '角标文案缺省「AI生成」')
      check(d.position === 'br', '角标位置缺省 br')
      check(d.margin_px === 24, '角标边距缺省 24')
      check(d.producer === '个人创作者', '创作主体缺省「个人创作者」')

      // 仅显式 false 关闭；非法字段清洗
      // 注：margin_px:999 为合法类型越界值，按 clamp 语义回落 200（与 c1 低端 clamp 对称）；类型非法才回落默认 24
      const off = bc.sanitizeCompliance({ enabled: false, text: '', position: 'xx' as never, margin_px: 999, producer: '  ' })
      check(off.enabled === false, '显式 enabled:false 才关闭')
      check(off.text === 'AI生成' && off.position === 'br' && off.producer === '个人创作者' && off.margin_px === 200, '非法字段回落默认值；越界 margin_px clamp 至 200')

      // clamp 与截断
      const c1 = bc.sanitizeCompliance({ margin_px: -5, text: 'x'.repeat(50), producer: 'y'.repeat(99) })
      check(c1.margin_px === 0, 'margin_px clamp 至 0–200')
      check(c1.text.length === 24, 'text 截断 24 字符')
      check(c1.producer.length === 60, 'producer 截断 60 字符')

      // mergeBrand 三层字段级覆盖 + 其余槽零影响
      const merged = bc.mergeBrand(
        { compliance: { producer: '平台主体' }, watermark: { position: 'tl' } },
        { compliance: { enabled: false, text: '项目文案' } },
        { compliance: { margin_px: 48 } },
      )
      check(merged.compliance?.producer === '平台主体', 'producer 平台层透传')
      check(merged.compliance?.enabled === false && merged.compliance?.text === '项目文案', '项目层字段覆盖')
      check(merged.compliance?.margin_px === 48, 'run 层字段覆盖')
      check(merged.watermark?.position === 'tl', '既有槽 merge 行为零变化')

      // resolveBrandConfig 恒填 compliance（隔离库：平台无配置 → 全缺省）
      const { createProject } = await import('./probe-m66-fixtures')
      const projectId = await createProject()
      const resolved = await bc.resolveBrandConfig(projectId, null)
      check(resolved.compliance?.enabled === true && resolved.compliance?.producer === '个人创作者', 'resolveBrandConfig 恒填 compliance（缺省开）')

      // normalizeCompliancePatch / normalizeBrandPatch compliance 槽（写路径逐级可关）
      const nc = bc.normalizeCompliancePatch({ enabled: false, text: '  自定义  ', margin_px: 999, position: 'tl' as never, producer: '' })
      check(
        nc.enabled === false && nc.text === '自定义' && nc.margin_px === 200 && nc.position === 'tl',
        'normalizeCompliancePatch 仅保留显式合法字段（trim/越界 clamp 至 200）',
      )
      check(!('producer' in nc), 'normalizeCompliancePatch 空 producer 键不保留')
      const p1 = bc.normalizeBrandPatch({ compliance: { enabled: false } })
      check(p1.compliance?.enabled === false && Object.keys(p1.compliance!).length === 1, 'normalizeBrandPatch 携带 compliance 槽且仅保留显式字段')
      let p2Threw = false
      try {
        bc.normalizeBrandPatch({ compliance: { bogus: 1 } })
      } catch {
        p2Threw = true
      }
      check(p2Threw, 'normalizeBrandPatch compliance 无合法字段时抛错')
    },
    'compose-args': async () => {
      const { buildComposeArgs } = await import('../src/pipeline/actions/ffmpeg-merge/args')
      const { complianceDrawtextFilter, resolveComplianceArg } = await import('../src/pipeline/actions/ffmpeg-merge/compliance')
      type ComposeArgsInput = import('../src/pipeline/actions/ffmpeg-merge/args').ComposeArgsInput

      // fixture 与已删除的 tmp-golden-m66.ts 完全一致（真实类型：Segment.id 为 number、TransitionPlan 含 totalDur）
      const base: ComposeArgsInput = {
        segments: [
          { id: 1, path: 'a.png', kind: 'image', durSec: 2 },
          { id: 2, path: 'b.mp4', kind: 'video', durSec: 3 },
        ],
        width: 1280,
        height: 720,
        fps: 30,
        xfadePlan: { enabled: false, type: 'fade', durSec: 0, videoLens: [2, 3], offsets: [], totalDur: 5 },
        voicePaths: [],
        lineIds: [],
        alignPlan: null,
        total: 5,
        srtAbs: null,
        style: '',
        bgmPath: null,
        bgmVolume: 1,
        bgmFade: 0,
        watermark: null,
        intro: null,
        outro: null,
        outAbs: '/tmp/out.mp4',
      }

      // 红线：compliance/metadataJson 缺省 → 与修改前黄金基线逐字节一致
      const r0 = buildComposeArgs(base)
      check(JSON.stringify(r0.args) === GOLDEN_ARGS, '缺省入参 args 与黄金基线逐字节一致')
      check(r0.cwd === GOLDEN_CWD, 'cwd 与黄金基线一致')
      check(!r0.args.some((a) => a.includes('AIGC') || a.includes('drawtext')), '缺省入参不含合规痕迹')

      // 显式关闭同样逐字节一致
      const rOff = buildComposeArgs({ ...base, compliance: null, metadataJson: null })
      check(JSON.stringify(rOff.args) === GOLDEN_ARGS, '显式 null 入参 args 逐字节一致')

      // 开启：drawtext 链 + videoOut 换标 + 每输出组 -metadata
      const font = 'C:/Windows/Fonts/msyh.ttc'
      const cArg = { text: 'AI生成', position: 'br' as const, margin_px: 24, fontAbs: font }
      const rOn = buildComposeArgs({ ...base, compliance: cArg, metadataJson: '{"Label":"1"}' })
      const fc = rOn.args[rOn.args.indexOf('-filter_complex') + 1]!
      check(fc.includes('drawtext=fontfile='), '角标 drawtext 已入 filter 链')
      check(fc.includes(`text='AI生成'`), '角标文案正确')
      // 本 fixture 无音频链 → [cmv] 即 filter 链末标签；videoOut 换标另以主输出组 -map 实证
      check(fc.includes('[cmv]'), '主链产出 [cmv] 标签')
      check(rOn.args[rOn.args.indexOf('-map') + 1] === '[cmv]', '主输出组 -map 已换标 [cmv]')
      const outIdx = rOn.args.indexOf('/tmp/out.mp4')
      // metaArgs 插入于 -movflags 之前（outIdx-1='+faststart'、outIdx-2='-movflags'）
      check(rOn.args[outIdx - 4] === '-metadata' && rOn.args[outIdx - 3] === 'AIGC={"Label":"1"}', '主输出组含 -metadata AIGC')
      check(!r0.args.includes('-metadata'), '对照：基线不含 -metadata')
      // 角标在链上位于字幕/水印之后（最顶层）：cmv 的来源标签为 outv
      check(/\[outv\]drawtext=/.test(fc) || /\[basev\]drawtext=/.test(fc), '角标叠加于字幕/水印之后')

      // complianceDrawtextFilter 纯函数：九宫格表达式与转义
      const f1 = complianceDrawtextFilter({ text: 'AI生成', position: 'br', margin_px: 24, fontAbs: 'C:/a b/msyh.ttc' }, 720)
      check(f1.includes('x=w-text_w-24') && f1.includes('y=h-text_h-24'), 'br 定位表达式正确')
      check(f1.includes("fontfile='C\\:/a b/msyh.ttc'"), 'fontfile 路径转义')
      const f2 = complianceDrawtextFilter({ text: "a'b:c", position: 'tc', margin_px: 0, fontAbs: 'f' }, 1080)
      check(f2.includes("text='a\\'b\\:c'"), 'drawtext 文本转义（单引号/冒号）')
      check(f2.includes('x=(w-text_w)/2') && f2.includes('y=0'), 'tc 居顶表达式')
      check(complianceDrawtextFilter({ text: 'x', position: 'bl', margin_px: 8, fontAbs: 'f' }, 480).includes('fontsize='), 'fontsize 已输出')

      // resolveComplianceArg：off → null；无字体 → null；on → 形参齐全
      const { sanitizeCompliance } = await import('../src/services/brand-config')
      check(resolveComplianceArg(sanitizeCompliance({ enabled: false })) === null, 'enabled:false → null')
      check(resolveComplianceArg(sanitizeCompliance({ enabled: true }), { WINDIR: 'C:/nonexistent-dir' }) === null, '无 CJK 字体 → null（调用方 warn）')
      const arg = resolveComplianceArg(sanitizeCompliance({ text: 'AI生成' }))
      check(!!arg && arg.text === 'AI生成' && !!arg.fontAbs, 'enabled:true → 角标参数齐全')
    },
  },
})
