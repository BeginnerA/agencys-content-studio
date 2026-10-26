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
    },
  },
})
