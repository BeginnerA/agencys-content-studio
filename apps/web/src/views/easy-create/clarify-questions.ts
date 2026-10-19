/**
 * 追问 chip 的「可否直接作答」判定（自 ConversationPanel.vue 抽出，供视图与探针共用）。
 *
 * clarify 决策的 questions 有两类语义，却共用同一套可点 chip：
 *  - 建议回复型：短句、以用户口吻写成，点一下即可作为答案发送（如「我换个说法重新描述」「用这些图片做素材混剪成片」，内置样例皆 ≤13 字）；
 *  - 开放追问型：要求用户上传文件 / 给出多维度说明（如「请上传原文…或说明可提供的范围」「改编目标是什么：平台、集数、时长…以及是否…」），
 *    点一下只是把问题原文抄进输入框，并非答案——此时界面对用户宣称「可直接作答」是误导。
 *
 * 用「长度超阈值 + 含开放请求词」双条件近似区分两类，命中任一即视为开放追问，
 * 整组标题随之降级为「带入输入框·请补充后发送」，不再承诺「直接作答」。
 */

/** 超过此字数（按 Unicode 码点计，兼容 CJK）基本不可能是「点一下即发送」的短回复。 */
const ELABORATE_MAX_LEN = 30

/** 明确指向「需用户提供内容」的请求词——短句里出现即说明这不是可点即答的建议回复。 */
const ELABORATE_MARKERS = [
  '上传', '请提供', '请补充', '请给出', '请说明', '请一并', '也请', '一并给出',
  '以及', '并说明', '或说明', '是否', '可多份', '若干', '格式', '范围',
]

/** 单条追问是否为开放追问（需用户真正补信息/传文件，而非点一下即答）。 */
export function isElaborateQuestion(q: string): boolean {
  const t = q.trim()
  if ([...t].length > ELABORATE_MAX_LEN) return true
  return ELABORATE_MARKERS.some((m) => t.includes(m))
}

/** 一组追问里只要有一条是开放追问，整组标题就不该承诺「直接作答」。 */
export function clarifyNeedsElaborate(questions: readonly string[]): boolean {
  return questions.some(isElaborateQuestion)
}

export const CLARIFY_HEADER_DIRECT = '点击下方问题可直接作答'
export const CLARIFY_HEADER_ELABORATE = '点击下方问题把要点带入输入框，请补充或上传素材后发送'

/** 依追问内容返回 chip 区标题：全为短回复 → 「可直接作答」；含开放追问 → 降级为「带入输入框·补充后发送」。 */
export function clarifyHeader(questions: readonly string[]): string {
  return clarifyNeedsElaborate(questions) ? CLARIFY_HEADER_ELABORATE : CLARIFY_HEADER_DIRECT
}
