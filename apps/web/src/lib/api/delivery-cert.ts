// 第五期 · 交付包认证：只读认证 API（与 apps/server routes/exports.ts 的 GET /runs/:id/delivery-cert 对齐）。
// 仅触发后端对已生成 edit_exchange 交付包的纯解析 + 结构/时长/媒体/字幕一致性判定，零付费、零模型、零写入业务表。
// 认证结论缓存回写于该导出资产 params.cert（零新列）；editor_import 恒列待人工实测，结构认证 ≠ 编辑器已验证通过。
import { api } from './core'
import type { CertFormat, DeliveryCertView } from '../types/delivery-cert'

const V = '/api/v1'

export const deliveryCertApi = {
  /**
   * 交付包只读认证报告。
   * 缺省按需重算并刷新缓存；`refresh=false` 优先命中缓存（做新鲜度判定，交付包 zip hash 变则旧报告标 stale）。
   * `format` 缺省由后端选取该 run 最新的一份 edit_exchange 包认证；门禁不足（run 不存在）后端返 404，ApiError.code=`run_not_found`。
   */
  get: (runId: number, opts?: { format?: CertFormat; refresh?: boolean }) => {
    const params = new URLSearchParams()
    if (opts?.format) params.set('format', opts.format)
    params.set('refresh', opts?.refresh === false ? '0' : '1')
    return api.get<DeliveryCertView>(`${V}/runs/${runId}/delivery-cert?${params.toString()}`)
  },
}
