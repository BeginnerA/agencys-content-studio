import { normalizeDialogueText, resolveNativeDialogueCaps } from '@agencys/ai-provider-kit'
import { CreationError, hashJson, type CreationPlan } from './contract'

/** 策划容量预检只排除明显超载；是否真实说完仍由音轨与逐字 ASR 核验。 */
export function assertDialogueCapacity(plan: CreationPlan): void {
  if (plan.performance !== 'dialogue') return
  for (const shot of plan.shots) {
    const text = plan.lines.filter((l) => shot.lines.includes(l.id)).map((l) => l.text).join('')
    if ([...normalizeDialogueText(text)].length > Math.floor((shot.duration - 0.5) * 4)) {
      throw new CreationError('dialogue_capacity', `镜头 ${shot.id} 台词过长，请减少台词或增加镜长并保持全片 30–60 秒`, 422)
    }
  }
}

/** 精确型号背书和强制音频选项共源，未知能力不能进入视频提交。 */
export function dialogueAudioOptions(provider: string, model: string): { generateAudio: true; promptExtend?: false } {
  const caps = resolveNativeDialogueCaps(provider, model)
  if (!caps) throw new CreationError('native_dialogue_unsupported', '当前视频型号未核实原生人物对白能力，请配置已支持型号', 422)
  return { generateAudio: true, ...(caps.promptExtend === false ? { promptExtend: false as const } : {}) }
}

/** 初次生成、重置返修与候选校验使用同一份批准数据编译，绝不只发送裸运动提示。 */
export function compileDialogueShot(plan: CreationPlan, shotId: string): {
  prompt: string; imagePrompt: string; dialogueHash: string; text: string; speaker: string
} {
  const shot = plan.shots.find((s) => s.id === shotId)
  if (plan.performance !== 'dialogue' || !shot || !plan.cast) throw new Error('缺少已批准对白镜头')
  const lines = plan.lines.filter((l) => shot.lines.includes(l.id))
  const cast = plan.cast.filter((c) => shot.characters?.includes(c.id))
  const speaker = lines[0]?.speaker
  if (!speaker || lines.some((l) => l.speaker !== speaker) || !cast.some((c) => c.id === speaker)) throw new Error('对白镜头说话人不合法')
  const roles = cast.map((c) => `${c.id}（${c.name}）：外貌 ${c.appearance}；声线 ${c.voice}；${c.id === speaker ? '本镜唯一发言者' : '同框倾听，不说话，只做自然反应'}`).join('\n')
  const imagePrompt = `${shot.image_prompt}\n统一风格：${plan.style}\n出场角色：\n${cast.map((c) => `${c.id}（${c.name}）：${c.appearance}`).join('\n')}\n人物在剧情内面对面交谈，不出现文字字幕。`
  const prompt = `${imagePrompt}\n画面动作：${shot.motion_prompt}\n角色表：\n${roles}\n逐字中文台词（按下列顺序由 ${speaker} 在画内开口说出）：\n${lines.map((l) => `${l.id}：${JSON.stringify(l.text)}；情绪：${l.emotion_hint ?? '自然，符合剧情'}`).join('\n')}\n生成原生同步人声与口型。其他角色倾听；不添加旁白，不分角色朗读，不添加额外台词，不生成画内字幕。保持角色外貌与声线描述，留出自然起止停顿。`
  return { prompt, imagePrompt, text: lines.map((l) => l.text).join(''), speaker,
    dialogueHash: hashJson({ version: 1, cast, lines, characters: shot.characters, speaker }) }
}
