/**
 * 模型参考图能力节（静态登记表 + 探针环境下的真实解析）。
 *
 * 断言边界说明：供应商真实上限**不在本探针锁死**——登记表按保守策略起步为空，
 * 未登记一律落保守缺省；后续按官方文档逐条校准登记时，本节只保证「缺省行为与登记行为」两档语义不变，
 * 不钉住任何具体供应商的数值上限（钉住会把校准动作变成改探针）。
 */
import assert from 'node:assert/strict'
import type { Checker } from '../../probe-lib'
import { DEFAULT_MAX_REFS, CAPS_FAILURE_NOTE_PREFIX, capsForProvider, capsResolutionFailure, resolveImageCaps } from '../../../src/services/image-caps'
import { test } from './helpers'

export async function runCaps(checker: Checker) {
  const t = (name: string, body: () => void | Promise<void>) => test(checker, name, body)

  await t('未登记供应商取保守缺省上限并在说明里标注来源', async () => {
    const caps = capsForProvider('some_vendor', 'some-model')
    assert.equal(caps.maxRefs, DEFAULT_MAX_REFS, `未登记上限取 ${DEFAULT_MAX_REFS}，实得 ${caps.maxRefs}`)
    assert.equal(DEFAULT_MAX_REFS, 4, '保守缺省为四张')
    assert.equal(caps.notes.length, 1, `带一条来源说明，实得 ${caps.notes.length}`)
    assert.ok(caps.notes[0]!.includes('保守缺省'), `说明含「保守缺省」，实得 ${caps.notes[0]}`)
    assert.ok(caps.notes[0]!.includes('some_vendor/some-model'), '说明把供应商与模型名带上便于事后核对')
  })

  await t('缺省键与模型名同样兜底（无入参也不抛错）', async () => {
    const caps = capsForProvider()
    assert.equal(caps.maxRefs, DEFAULT_MAX_REFS, '空入参仍取保守缺省')
    assert.ok(caps.notes[0]!.includes('未登记模型'), `说明标注未登记，实得 ${caps.notes[0]}`)
  })

  await t('负向提示词通道仅 comfy 与 kling 两条供应商键开启', async () => {
    assert.equal(capsForProvider('comfyui_local').supportsNegativePrompt, true, '含 comfy 键开启负向通道')
    assert.equal(capsForProvider('KLING_V2').supportsNegativePrompt, true, '键判定大小写不敏感')
    assert.equal(capsForProvider('openai_image').supportsNegativePrompt, false, '其余供应商不开启')
    assert.equal(capsForProvider('kling').supportsNegativePrompt, true, '精确等于白名单项同样开启')
    assert.equal(capsForProvider(undefined).supportsNegativePrompt, false, '缺省键不开启')
  })

  await t('探针环境（无端点配置）解析参考图能力：保守返回不支持且不抛穿', async () => {
    const caps = await resolveImageCaps()
    assert.equal(caps.supportsRefs, false, '无图像端点配置时按不支持参考图处理')
    assert.equal(caps.maxRefs, DEFAULT_MAX_REFS, '上限仍取保守缺省')
    assert.ok(Array.isArray(caps.notes) && caps.notes.length >= 1, '说明数组至少一条')
    assert.ok(caps.notes.some((n) => n.startsWith(CAPS_FAILURE_NOTE_PREFIX)), `降级原因单独留痕（前缀「${CAPS_FAILURE_NOTE_PREFIX}」）`)
    assert.ok(caps.notes.some((n) => n.includes('按不支持参考图处理')), '说明直述降级后的取用口径')
  })

  await t('解析失败与供应商真实声明不支持可区分（失败降级有独立判据）', async () => {
    const caps = await resolveImageCaps('openai_image', 'gpt-image-1')
    assert.equal(caps.supportsRefs, false, '配置缺失时不支持')
    const failure = capsResolutionFailure(caps)
    assert.ok(failure !== null && failure.startsWith(CAPS_FAILURE_NOTE_PREFIX), `失败降级判据命中，实得 ${String(failure)}`)
    const okCaps = { supportsRefs: true, maxRefs: 4, supportsNegativePrompt: false, notes: [] }
    assert.equal(capsResolutionFailure(okCaps), null, '真实支持时判据返回空（两种成因不混同）')
  })

  await t('能力说明里的失败原因经清洗（不携带凭据与地址原文）', async () => {
    const caps = await resolveImageCaps()
    const joined = caps.notes.join('\n')
    assert.ok(!/https?:\/\//.test(joined), `说明不落完整端点地址，实得 ${joined}`)
    assert.ok(!/\bsk-[A-Za-z0-9]{6,}/.test(joined), '说明不含密钥形态')
    assert.ok(joined.length < 400, '说明受长度预算约束')
  })
}
