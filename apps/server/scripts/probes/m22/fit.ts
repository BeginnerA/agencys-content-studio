/** M22[P2] fit：归一链二选一（断言体逐字搬自原 probe-m22.ts） */
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, buildComposeArgs } = ctx
  const fcOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1] ?? ''
  const base = { videoPaths: ['v1.mp4', 'v2.mp4'], audioPaths: [], outPath: 'o.mp4', size: { width: 1080, height: 1920 } }
  const fcCrop = fcOf(buildComposeArgs({ ...base, fit: 'crop' }))
  check(
    fcCrop.includes('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1') && !fcCrop.includes('pad='),
    'crop：scale increase + crop + setsar（无 pad）',
  )
  const fcPad = fcOf(buildComposeArgs(base))
  check(
    fcPad.includes('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1') && !fcPad.includes('crop='),
    'pad 缺省：信箱链逐字不变（零漂移）',
  )
  check(fcOf(buildComposeArgs({ ...base, fit: 'pad' })) === fcPad, "显式 fit='pad' 与缺省一致")
  check(fcOf(buildComposeArgs({ ...base, fit: 'crop', fps: 30 })).includes('crop=1080:1920,setsar=1,fps=30'), 'crop 链 + fps 后缀')
}
