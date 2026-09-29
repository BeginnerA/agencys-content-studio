/**
 * 模板配置字典：把 YAML 模板字段翻译成普通使用者能看懂的说明。
 * 纯展示层数据（不参与引擎执行），供「字段速查」弹层与说明书视图消费。
 * [同步] ACTION_TEXT/ACTION_DESC 的键须与 server `apps/server/src/pipeline/loader.ts`
 * 的 KNOWN_ACTIONS 同步维护（新增 action 时两处都加）。
 */

export interface HelpItem {
  name: string
  desc: string
  example?: string
}

export interface HelpGroup {
  title: string
  note?: string
  items: HelpItem[]
}

/** 12 种 action 的通俗名（步骤列表/流程徽标旁展示） */
export const ACTION_TEXT: Record<string, string> = {
  manual_ingest: '素材导入',
  ai_text: 'AI 写文本',
  ai_image: 'AI 出图',
  ai_video: 'AI 生成视频',
  tts: '配音合成',
  subtitle: '字幕生成',
  ffmpeg_merge: '合成成片',
  memory_write: '写入记忆',
  memory_recall: '召回记忆',
  character_sync: '角色建档',
  entity_sync: '场景道具建档',
  text_split: '文本切分',
}

/** action 一句话用途（速查表「动作字典」组） */
const ACTION_DESC: Record<string, string> = {
  manual_ingest: '到 Web 里粘贴文本或上传素材，人工准备物料',
  ai_text: '按提示词文件生成文稿、台词、分镜文案等文本',
  ai_image: '按分镜或提示词生成图片；批量步骤通常是「每个分镜一张图」',
  ai_video: '为分镜生成视频片段；支持首帧参考图保持视觉一致',
  tts: '把台词逐句合成配音（声线可在角色库或默认参数里定）',
  subtitle: '对白切句估时，产出可烧录的字幕文件（SRT）',
  ffmpeg_merge: '把画面 + 配音 + 字幕合成一条成片 mp4',
  memory_write: '把这一步的内容沉淀到长期记忆，供以后创作参考',
  memory_recall: '从长期记忆里检索参考内容，注入后续生成',
  character_sync: '角色档案 + 定妆照入库，保证跨集角色不漂移',
  entity_sync: '场景 / 道具档案与参考图入库，供出图时锚定',
  text_split: '长文（如小说）按章切分，产出章节资产',
}

export function actionText(a: string): string {
  return ACTION_TEXT[a] ?? a
}

/** 输入字段类型：中文名 + 说明（说明书视图与速查表共用；键须与服务端 loader inputs kind 合法集同步维护） */
export const KIND_TEXT: Record<string, string> = {
  text: '文本',
  int: '整数',
  float: '小数',
  bool: '开关',
  select: '单选',
  multi_select: '多选',
  date: '日期',
  files: '文件',
  publications: '发布记录',
}

const KIND_DESC: Record<string, string> = {
  text: '一句话或一段话（如：创意、目标平台）',
  int: '整数（如：目标秒数、数量）',
  float: '小数（如：音量比例、倍速）',
  bool: '是 / 否 开关',
  select: '从 options 候选项里单选（下拉框，如：风格、分辨率）',
  multi_select: '从 options 候选项里多选（如：目标平台、标签）',
  date: '日期（YYYY-MM-DD，日期选择器）',
  files: '图片 / 音频等文件（可用 accept 限定格式）',
  publications: '勾选项目发布记录（复盘回灌专用，无需导 CSV）',
}

/** 字段速查弹层的分组内容（新建模板「能配什么」的完整字典） */
export const HELP_GROUPS: HelpGroup[] = [
  {
    title: '模板信息（YAML 最外层）',
    note: '决定模板叫什么、出现在哪里、如何被挑选。',
    items: [
      {
        name: 'key',
        desc: '模板唯一标识，同时是文件名；创建后不可修改',
        example: 'quick-video',
      },
      {
        name: 'version',
        desc: '版本号，做了实质修改后 +1（仅作标识，不影响运行）',
        example: '1',
      },
      {
        name: 'name',
        desc: '模板显示名，出现在场景卡、项目页等界面',
        example: '快速视频',
      },
      {
        name: 'description',
        desc: '一句话介绍（“适合：… 流程：…”），帮使用者挑选模板',
        example: '适合：一句话创意快速出片',
      },
      {
        name: 'genre',
        desc: '体裁标签，用于展示分类',
        example:
          'drama_short（短剧）/ talking_head（口播）/ note（图文）/ article（长文）',
      },
      {
        name: 'scene',
        desc: '出现在「启动流水线」的哪个分组',
        example: 'produce 出成品 / plan 做规划 / operate 发布与复盘',
      },
      {
        name: 'next',
        desc: '完成后推荐的下游模板（运行页「下一步建议」）',
        example: '[review-restock]',
      },
    ],
  },
  {
    title: '启动表单 inputs（运行时先让使用者填写）',
    note: '每个列表项 = 一个填写字段；不声明 inputs 则无需填写、直接启动。',
    items: [
      {
        name: 'key',
        desc: '字段标识，下游步骤用 input.<key> 取它的值',
        example: 'idea',
      },
      {
        name: 'label',
        desc: '显示给填写者的问题文字',
        example: '创意/选题（一句话即可）',
      },
      { name: 'kind', desc: '字段类型，见下方「输入类型」', example: 'text' },
      { name: 'required', desc: '是否必填（true / false）', example: 'true' },
      {
        name: 'accept',
        desc: 'kind 为 files 时限定文件格式（可选）',
        example: '[image/*]',
      },
      {
        name: 'options',
        desc: 'kind 为 select / multi_select 时的候选项列表（必填，非空字符串数组）',
        example: '[抖音, 小红书, 视频号]',
      },
      {
        name: 'default',
        desc: '默认值，类型须与 kind 一致（multi_select 默认值为数组，需均在 options 内；可选）',
        example: '抖音',
      },
    ],
  },
  {
    title: '默认参数 defaults',
    note: '预设供应商 / 模型 / 音色 / 尺寸等；项目设置与运行表单的「本集参数覆盖」可以覆盖它。',
    items: [
      {
        name: 'llm',
        desc: '文本生成的默认参数',
        example: 'temperature: 0.7, max_tokens: 12000',
      },
      {
        name: 'image',
        desc: '出图的默认供应商与尺寸',
        example: 'provider: pollinations_image, size: "1536x1024"',
      },
      {
        name: 'audio',
        desc: '配音的默认供应商与声线',
        example: 'provider: pollinations_audio, voice: "Cherry"',
      },
      {
        name: 'video',
        desc: '视频生成的默认供应商等',
        example: 'provider: pollinations_video',
      },
    ],
  },
  {
    title: '流水线步骤 steps（按顺序做哪些事）',
    note: '每个列表项 = 一个步骤，按声明顺序从上往下跑（可用 after 调整依赖）。',
    items: [
      {
        name: 'key',
        desc: '步骤标识；下游用 steps.<key>.asset 或 .assets 引用它的产物',
        example: 'draft',
      },
      {
        name: 'action',
        desc: '这一步具体做什么——12 种动作见「动作字典」',
        example: 'ai_text',
      },
      {
        name: 'title',
        desc: '步骤显示名，出现在时间线与工作台上',
        example: '快脚本',
      },
      {
        name: 'inputs',
        desc: '输入从哪来：input.<字段> 来自启动表单；steps.<上游>.asset(s) 来自前序产物；也可直接写固定值',
        example: 'idea: input.idea',
      },
      {
        name: 'params',
        desc: '这一步的参数，如 prompt_tpl（用哪个提示词文件）、name_tpl（产物文件名）',
        example: 'prompt_tpl: quick-script.md',
      },
      {
        name: 'gate',
        desc: '人工审阅闸门：执行前暂停，等你在 Web 上批准 / 驳回 / 跳过',
        example: 'mode: required, message: 请审阅脚本…',
      },
      {
        name: 'batch',
        desc: '批量展开：field 指向数组输入，逐项分别执行；max_concurrent 并发数；retry 失败重试',
        example: '{ field: shots, max_concurrent: 2, retry: 1 }',
      },
      {
        name: 'when',
        desc: '条件执行：满足条件才跑（可引用 input 或 steps.x.count）',
        example: 'input.confirm == true',
      },
      {
        name: 'when_any',
        desc: '条件执行（任一满足即可），多个条件的「或」组',
        example: '["steps.a.count > 0", "steps.b.count > 0"]',
      },
      {
        name: 'after',
        desc: '声明依赖哪些上游步骤；不写 = 紧随上一步；[] = 无依赖、可并行',
        example: '[recall]',
      },
      {
        name: 'output',
        desc: '产物标记，例如把这一步标记为成片（final_video）',
        example: 'purpose: final_video',
      },
    ],
  },
  {
    title: '动作字典 action（12 种可复用的步骤动作）',
    note: '模板由这些既有动作组合而成——新增模板通常不需要写代码。',
    items: Object.entries(ACTION_TEXT).map(([k, v]) => ({
      name: k,
      desc: ACTION_DESC[k] ?? v,
      example: v,
    })),
  },
  {
    title: '输入类型 kind（输入字段的可选类型）',
    items: Object.entries(KIND_TEXT).map(([k, v]) => ({
      name: k,
      desc: KIND_DESC[k] ?? v,
      example: v,
    })),
  },
]
