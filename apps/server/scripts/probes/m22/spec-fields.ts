/** M22[P0] spec-fields：compose 新字段归一化（断言体逐字搬自原 probe-m22.ts） */
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, parseNodeSpec, SUBTITLE_MODES, COMPOSE_FITS } = ctx
  const ok = parseNodeSpec({ genKind: 'compose', prompt: 'p', align: true, subtitle: 'asset', subtitleAssetId: 7, burnSubtitles: true, fit: 'crop' })
  check(
    ok.align === true && ok.subtitle === 'asset' && ok.subtitleAssetId === 7 && ok.burnSubtitles === true && ok.fit === 'crop',
    '五个新字段合法值全量通过',
  )

  const bare = parseNodeSpec({ genKind: 'compose' })
  check(
    bare.align === undefined && bare.subtitle === undefined && bare.subtitleAssetId === undefined && bare.burnSubtitles === undefined && bare.fit === undefined,
    '缺省不注入新字段（零漂移）',
  )

  const bad = (raw: unknown): boolean => {
    try {
      parseNodeSpec(raw)
      return false
    } catch {
      return true
    }
  }
  check(bad({ genKind: 'compose', subtitle: 'kling' }), 'subtitle 非法枚举被拒')
  check(bad({ genKind: 'compose', fit: 'stretch' }), 'fit 非法枚举被拒')
  check(bad({ genKind: 'compose', align: 'yes' }), 'align 非布尔被拒')
  check(bad({ genKind: 'compose', burnSubtitles: 1 }), 'burnSubtitles 非布尔被拒')
  check(bad({ genKind: 'compose', subtitleAssetId: 0 }), 'subtitleAssetId 非正整数被拒')
  check(bad({ genKind: 'compose', subtitleAssetId: 1.5 }), 'subtitleAssetId 小数被拒')
  check(SUBTITLE_MODES.join('|') === 'none|auto|asset' && COMPOSE_FITS.join('|') === 'pad|crop', '枚举常量序列符合 spec')
}
