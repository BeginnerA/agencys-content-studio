/** M44 离线探针：按增量扩展；不读取正式库，不发送付费请求。 */
import { isolatedEnv, makeChecker, runSections } from './probe-lib'

const { cleanup } = isolatedEnv('m44', { bridge: ['templates', 'prompts'] })
const { createLogger } = await import('../src/logger')
const { creationPlanSchema } = await import('../src/services/creation-chat/contract')
const log = createLogger('probe-m44')
const checker = makeChecker(log)
const check = checker.check

export function dialogueFixture() {
  const texts = ['信怎么不见了？', '我把信放在抽屉里了。', '可是抽屉里没有啊。', '别着急，我陪你一起找。']
  return {
    title: '寻找信件', summary: '两人一起找信', genre: 'story' as const, duration: 32,
    aspectRatio: '9:16' as const, language: 'zh-CN' as const, mode: 'dynamic' as const,
    style: '生活写实', script: texts.join('\n'),
    lines: texts.map((text, i) => ({ id: `l${i + 1}`, text, speaker: i % 2 ? 'b' : 'a' })),
    shots: texts.map((_, i) => ({ id: `s${i + 1}`, duration: 8, image_prompt: '两人在书房面对面交谈', motion_prompt: '固定机位，对手倾听', lines: [`l${i + 1}`], characters: ['a', 'b'] })),
    refs: [], performance: 'dialogue' as const,
    cast: [
      { id: 'a', name: '小林', appearance: '短发，蓝色衬衣', voice: '青年女性，清亮自然' },
      { id: 'b', name: '小陈', appearance: '黑发，灰色毛衣', voice: '青年男性，温和低沉' },
    ],
  }
}

await runSections({ log, title: 'M44', checker, cleanup, sections: ['contract', 'providers', 'asr', 'recipe', 'asr-config', 'planning', 'media', 'asr-tasks', 'preflight', 'engine', 'review', 'recovery', 'recovery-client', 'rework', 'recompose'], runners: {
  recompose: async () => (await import('./probes/m44/recompose')).probeDialogueRecompose(checker, creationPlanSchema.parse(dialogueFixture())),
  rework: async () => (await import('./probes/m44/rework')).probeDialogueRework(checker, creationPlanSchema.parse(dialogueFixture())),
  recovery: async () => (await import('./probes/m44/recovery')).probeDialogueRecovery(checker, creationPlanSchema.parse(dialogueFixture())),
  'recovery-client': async () => (await import('./probes/m44/recovery')).probeRecoveryClient(checker),
  review: async () => (await import('./probes/m44/review')).probeDialogueReview(checker, creationPlanSchema.parse(dialogueFixture())),
  engine: async () => (await import('./probes/m44/engine')).probeDialogueEngine(checker),
  preflight: async () => (await import('./probes/m44/preflight')).probeDialoguePreflight(checker, creationPlanSchema.parse(dialogueFixture())),
  'asr-tasks': async () => (await import('./probes/m44/asr-tasks')).probeAsrTasks(checker, creationPlanSchema.parse(dialogueFixture())),
  media: async () => (await import('./probes/m44/media')).probeMedia(checker, creationPlanSchema.parse(dialogueFixture())),
  planning: async () => (await import('./probes/m44/planning')).probePlanning(checker, creationPlanSchema.parse(dialogueFixture())),
  'asr-config': async () => (await import('./probes/m44/asr-config')).probeAsrConfig(checker),
  recipe: async () => (await import('./probes/m44/recipe')).probeRecipe(checker, creationPlanSchema.parse(dialogueFixture())),
  asr: async () => (await import('./probes/m44/asr')).probeAsr(checker),
  providers: async () => {
    const kit = await import('@agencys/ai-provider-kit')
    const resolve = kit.resolveNativeDialogueCaps
    check(typeof resolve === 'function', '公开原生对白精确型号能力查询')
    if (typeof resolve !== 'function') return
    for (const model of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615']) {
      check(resolve('volcengine_video', model)?.generateAudio === true, `${model} 明确启用声音`)
    }
    for (const model of ['wan3.0-video', 'wan3.0-video-prime']) {
      check(resolve('aliyun_bailian_video', model)?.promptExtend === false, `${model} 关闭台词扩写`)
    }
    check(resolve('volcengine_video', 'doubao-seedance-2-future') === null, '未来型号不自动背书')
    check(resolve('aliyun_bailian_video', 'kling-unknown') === null, '同供应商第三方型号不自动背书')
    check(resolve('minimax_video', 'MiniMax-Hailuo-2.3') === null, '未知对白协议拒绝')
  },
  contract: async () => {
    const plan = dialogueFixture()
    check(creationPlanSchema.safeParse(plan).success, '两名角色四轮原生对白契约通过')
    const legacy = { ...plan } as Record<string, unknown>
    delete legacy.performance
    delete legacy.cast
    legacy.lines = plan.lines.map(({ speaker: _speaker, ...line }) => line)
    legacy.shots = plan.shots.map(({ characters: _characters, ...shot }) => shot)
    const old = creationPlanSchema.parse(legacy)
    check(JSON.stringify(old) === JSON.stringify(legacy), '历史方案序列化逐字不变，不插入表现形式默认值')
    check(!creationPlanSchema.safeParse({ ...plan, mode: 'slideshow' }).success, '对白拒绝图文模式')
    check(!creationPlanSchema.safeParse({ ...plan, cast: [plan.cast[0]] }).success, '对白至少两名角色')
    check(!creationPlanSchema.safeParse({ ...plan, cast: [plan.cast[0], plan.cast[0]] }).success, '拒绝重复角色 ID')
    check(!creationPlanSchema.safeParse({ ...plan, lines: plan.lines.map((line) => ({ ...line, speaker: 'ghost' })) }).success, '拒绝幽灵说话人')
    check(!creationPlanSchema.safeParse({ ...plan, lines: plan.lines.map((line) => ({ ...line, speaker: 'a' })) }).success, '单人朗读不能冒充人物对白')
    check(!creationPlanSchema.safeParse({ ...plan, shots: plan.shots.map((shot) => ({ ...shot, characters: ['a'] })) }).success, '说话角色必须出场')
    check(!creationPlanSchema.safeParse({ ...plan, performance: 'narration' }).success, '旁白不能携带未消费的对白字段')
    check(!creationPlanSchema.safeParse({ ...plan, lines: plan.lines.map(({ speaker: _speaker, ...line }) => line) }).success, '对白不得缺失说话人')
    const mixed = structuredClone(plan)
    mixed.shots[0]!.lines = ['l1', 'l2']
    mixed.shots[1]!.lines = []
    check(!creationPlanSchema.safeParse(mixed).success, '首版拒绝单镜多人抢话')
  },
} })
