/**
 * 剪辑工程交换导出：Web 端共享逻辑单一真源。
 * 运行详情成片卡（RunStepCard 经 use-run-extras 探测）与轻松创作成片区（CreationResult 本地探测）
 * 两处入口复用同一格式能力表 + 纯函数判定 + 探测/生成下载序列，避免逻辑漂移。
 */
import { editExchangeApi } from './api'
import { triggerDownload } from './download'
import type { EditExchangeFormat, EditExchangeFormatsResult } from './api'

export interface EditExchangeFormatMeta {
  key: EditExchangeFormat
  label: string
  hint: string
}

/** 三格式能力表（按目标软件兼容矩阵标注；EDL 为语义降级面：仅视频 + 旁白轨） */
export const EDIT_EX_FORMATS: EditExchangeFormatMeta[] = [
  { key: 'fcpxml', label: 'FCPXML', hint: '剪映 / Final Cut / DaVinci Resolve' },
  { key: 'edl', label: 'EDL', hint: 'Premiere / Avid（仅视频 + 旁白轨，降级面）' },
  { key: 'otio', label: 'OTIO', hint: 'Resolve / 程序化管线' },
]

/** 某格式是否可导出（能力探测可用 + 该格式 enabled；未探测到一律 false） */
export function editExEnabled(
  r: EditExchangeFormatsResult | null,
  key: EditExchangeFormat,
): boolean {
  if (!r?.available) return false
  return r.formats.find((f) => f.format === key)?.enabled ?? true
}

/** 按钮 title 提示：不可用时回服务端 reason，可用时标注目标软件 + 时间轴来源 */
export function editExTitle(
  r: EditExchangeFormatsResult | null,
  key: EditExchangeFormat,
  busy: boolean,
): string {
  if (!r) return ''
  if (busy) return '正在生成剪辑工程包…'
  if (!r.available) return r.reason ?? '当前无法导出剪辑工程'
  const meta = EDIT_EX_FORMATS.find((x) => x.key === key)
  return `导出多轨工程 → ${meta?.hint ?? ''}${
    r.timeline_source === 'recomputed' ? '（时间轴按分镜重算）' : ''
  }`
}

/** 能力探测（失败静默置 null，不阻断主视图） */
export async function probeEditExchangeFormats(
  runId: number,
): Promise<EditExchangeFormatsResult | null> {
  try {
    return await editExchangeApi.formats(runId)
  } catch {
    return null
  }
}

/** 生成剪辑工程包并触发浏览器下载（错误向上抛，由调用方落提示） */
export async function createEditExchangeDownload(
  runId: number,
  format: EditExchangeFormat,
) {
  const res = await editExchangeApi.create(runId, format)
  triggerDownload(editExchangeApi.fileUrl(res.asset.id, true), res.asset.name)
  return res
}
