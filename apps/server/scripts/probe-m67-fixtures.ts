import { zipSync, strToU8 } from 'fflate'

/** probe-m67 夹具：最小项目播种 + xlsx 现场打包（列名以 src/db/schema.ts 为准，缺列时按 NOT NULL 约束补齐） */
export async function createProject(): Promise<number> {
  const { db } = await import('../src/db')
  const { projects } = await import('../src/db/schema')
  const now = Date.now()
  const rows = await db.insert(projects).values({ name: 'M67探针项目', createdAt: now, updatedAt: now }).returning()
  return rows[0]!.id
}

/** 探针专用：fflate zipSync 现场打包最小 xlsx（只需读取器消费的三类条目） */
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'

/** 探针专用：全零内容 xlsx 条目（解压后 128MB+1 字节，deflate 压缩后极小）——zip 炸弹防护夹具 */
export function makeZipBombXlsx(): Buffer {
  return Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(128 * 1024 * 1024 + 1) }))
}

export function makeXlsx(sheetXml: string, sharedStrings: string[], stylesXml?: string): Buffer {
  const entries: Record<string, Uint8Array> = {
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheetXml}</sheetData></worksheet>`),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst ${NS} count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.join('')}</sst>`),
  }
  if (stylesXml) entries['xl/styles.xml'] = strToU8(stylesXml)
  return Buffer.from(zipSync(entries))
}
