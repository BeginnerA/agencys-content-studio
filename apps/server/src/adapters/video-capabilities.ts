/**
 * [M32] 视频模型能力/默认单一真源表（Tier A 基建）。
 *
 * 背景：视频模型的档位（时长 / 分辨率 / 生成模式 / 画幅）此前散落在三处——
 *   ① 各适配器 generate 内的 normalize（minimax/volcengine/pollinations）、
 *   ② 预检 assertAdapterDurations 的硬编码分支、
 *   ③ 前端 applyCapsPreset + capsHint 的硬编码预填与提示——
 * 三处各自维护、易自相矛盾，且逼用户逐项勾选「已核实」。本模块收敛为**唯一真源**：
 *   - resolveVideoCaps：预检与前端 caps 端点共用，命中即「平台按适配器实测约束背书」（Tier A）；
 *   - clampDuration / mapResolution / snapDuration：供适配器委托，消除 ① 的平行魔法数。
 * 纪律：仅登记经供应商文档 / 适配器实现核实的事实，未按模型名猜测；未命中返回 null（fail-closed，须显式声明）。
 */

export type CapsMode = 'i2v' | 't2v'
export type CapsAspect = '9:16' | '16:9' | '1:1'
export type CapsResolution = '480p' | '720p' | '1080p' | '768P' | '2K'

export interface VideoModelCaps {
  /** 支持的生成模式（i2v 需配合 adapter.firstFrame==='base64' 才在预检生效） */
  modes: CapsMode[]
  /** 合法时长档位（升序去重，单位秒）；预检按「最小 ≥ 镜头时长」就近取档 */
  durations: number[]
  /** 支持画幅 */
  aspectRatios: CapsAspect[]
  /** 支持分辨率档位 */
  resolutions: CapsResolution[]
  /** Tier A 推荐默认（前端预填起点） */
  defaultDuration: number
  defaultResolution: CapsResolution
}

const ALL_ASPECTS: CapsAspect[] = ['9:16', '16:9', '1:1']

function secondsRange(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let n = lo; n <= hi; n++) out.push(n)
  return out
}

/**
 * 依 providerKey + model 解析已背书档位；未命中（未知供应商 / 无核实依据的模型）返回 null。
 * 逐条事实来源见各分支注释（对齐对应适配器实现的 normalize）。
 */
export function resolveVideoCaps(providerKey: string, model: string): VideoModelCaps | null {
  const m = (model || '').toLowerCase()
  switch (providerKey) {
    case 'minimax_video':
      // MiniMax H3：时长透传 4–15 秒；分辨率仅 768P / 2K（480p/720p→768P，1080p/2K→2K）
      return { modes: ['i2v', 't2v'], durations: secondsRange(4, 15), aspectRatios: ALL_ASPECTS, resolutions: ['768P', '2K'], defaultDuration: 5, defaultResolution: '768P' }
    case 'volcengine_video':
      // 火山 Seedance 2.0：时长 4–15 秒；分辨率仅 480p / 720p（1080p 收敛 720p）
      return { modes: ['i2v', 't2v'], durations: secondsRange(4, 15), aspectRatios: ALL_ASPECTS, resolutions: ['480p', '720p'], defaultDuration: 5, defaultResolution: '720p' }
    case 'aliyun_wan_video':
      // 万相 3.0：时长 2–30 秒整数（或 -1 自适应）；分辨率 480P / 720P / 1080P
      return { modes: ['i2v', 't2v'], durations: secondsRange(2, 30), aspectRatios: ALL_ASPECTS, resolutions: ['480p', '720p', '1080p'], defaultDuration: 5, defaultResolution: '720p' }
    case 'pollinations_video': {
      // Pollinations 网关：同步长请求、不支持首帧注入（无 i2v）；
      // minimax 系上游仅收 5 / 10 / 15 秒且实测产出 480p；其余模型 5 / 10 秒、720p。
      const isMinimax = /minimax/.test(m)
      return { modes: ['t2v'], durations: isMinimax ? [5, 10, 15] : [5, 10], aspectRatios: ALL_ASPECTS, resolutions: isMinimax ? ['480p'] : ['720p'], defaultDuration: 5, defaultResolution: isMinimax ? '480p' : '720p' }
    }
    // siliconflow_video：适配器不下发 duration，真实产出时长由模型固定且未文档化 → 无核实依据，不自动背书（返回 null，须显式声明）。
    default:
      return null
  }
}

/**
 * 时长就近归一（供 minimax / volcengine 适配器委托）：复刻原 normalize——
 * `Math.round(Number(duration || default))`，非有限回落默认，再夹到 [档位下界, 档位上界]。
 * 与迁移前逐值一致（probe-m32 adapter-normalize 节断言）。
 */
export function clampDuration(providerKey: string, model: string, duration?: number): number {
  const caps = resolveVideoCaps(providerKey, model)
  const fallback = caps?.defaultDuration ?? 5
  const parsed = Math.round(Number(duration || fallback))
  if (!Number.isFinite(parsed)) return fallback
  if (!caps || !caps.durations.length) return parsed
  const lo = caps.durations[0]!
  const hi = caps.durations[caps.durations.length - 1]!
  return Math.min(hi, Math.max(lo, parsed))
}

/**
 * 分辨率归一（供 minimax / volcengine 适配器委托）：
 * - minimax：2k/1080p → '2K'，其余 → '768P'；
 * - volcengine：恰为 '480p' → '480p'，其余 → '720p'；
 * - 其它 / 未知：原样透传（无归一依据，不猜）。
 */
export function mapResolution(providerKey: string, resolution?: string): string {
  if (providerKey === 'minimax_video') {
    const r = (resolution || '').toLowerCase()
    return r === '2k' || r === '1080p' ? '2K' : '768P'
  }
  if (providerKey === 'volcengine_video') {
    return resolution === '480p' ? '480p' : '720p'
  }
  return resolution || ''
}

/**
 * Pollinations 时长取档（供其适配器委托）：非 minimax 模型四舍五入透传；
 * minimax 系仅收 5 / 10 / 15，就近取档（≤7→5、8–12→10、≥13→15）。复刻原实现。
 */
export function snapPollinationsDuration(model: string, sec: number): number {
  const v = Math.round(sec)
  if (!/minimax/i.test(model)) return v
  if (v <= 7) return 5
  if (v <= 12) return 10
  return 15
}
