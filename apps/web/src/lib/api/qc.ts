// 第四期 · 统一 QC 面板：只读核验 API（与 apps/server routes/qc.ts 对齐）。
// 仅触发后端本地 ffprobe/ffmpeg 测量 + 台账一致性汇总，零付费、零模型；不改 delivery_checked / 批准链。
import { api } from './core'
import type { QcReportView } from '../types/qc'

const V = '/api/v1'

export const qcApi = {
  /**
   * 成片质量核验报告。
   * 缺省按需重算并刷新缓存；`refresh=false` 优先命中缓存（做新鲜度判定，成片 hash 变则相关结论标 stale）。
   * 门禁不足（无成片 / run 不存在）后端返 404，ApiError.code 为 `no_final_video` / `not_found`，供 UI 区分文案。
   */
  get: (runId: number, refresh = true) =>
    api.get<QcReportView>(`${V}/runs/${runId}/qc?refresh=${refresh ? 1 : 0}`),
}
