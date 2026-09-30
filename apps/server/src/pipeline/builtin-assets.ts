import { templateFlags } from './loader'

/**
 * 内置资产清单（系统出厂提示词的唯一真源）。
 *
 * 语义：随产品发布、写在出厂 workspace/ 里的资产属于「系统内置」——用户只读，不可修改、不可删除
 * （服务端 routes + loader 据此拒绝，前端据此锁定编辑/删除入口）；用户运行期新建 / 另存为副本 / 画布编辑落盘的资产视为「自定义」，可随意改删。
 *
 * 模板的「是否内置 / 是否轻松创作专用 / 审阅变体」已下沉为各出厂 YAML 顶层的
 * builtin/visibility/review_variant 标记（单一真源在模板文件自身，由 loader.templateFlags 派生）：
 * 新增或下架一份出厂模板只需改该模板自身文件，无需再维护中心清单——这正是本次架构根治的动机。
 * 提示词暂仍以下面的路径集合维护（新增一份出厂提示词时把相对路径同步进来）。
 */

/** 出厂内置提示词相对路径（workspace/prompts/*.md，POSIX 斜杠，共 48 份） */
export const BUILTIN_PROMPT_NAMES: ReadonlySet<string> = new Set<string>([
  'adapt-audit.md',
  'adapt-script.md',
  'adapt-text.md',
  'adapt-video.md',
  'article-draft.md',
  'canvas-advice.md',
  'chapter-events.md',
  'char-profile.md',
  'compliance-review.md',
  'cover-note.md',
  'cover-talking.md',
  'creation-plan.md',
  'draft-note.md',
  'draft-talking.md',
  'edit-audit.md',
  'entity-polish.md',
  'eval-consistency.md',
  'event-graph.md',
  'image-analyze.md',
  'image-copy.md',
  'inline-note.md',
  'lines-cast-ep.md',
  'lines-cast.md',
  'lines-timing.md',
  'memory-summary.md',
  'monetize-structure.md',
  'plan-episodes.md',
  'plan-video.md',
  'publish-note.md',
  'quick-script.md',
  'ref-prompts.md',
  'restock-topics.md',
  'review-data.md',
  'script-audit.md',
  'script-ep.md',
  'series-setup.md',
  'set-profile.md',
  'set-ref-prompts.md',
  'split-regex.md',
  'storyboard-ep.md',
  'storyboard-narrative.md',
  'style-extract.md',
  'topic-radar.md',
  'translate-lines.md',
  'translate-text.md',
  'video-analyze.md',
  'video-copy.md',
  'video-storyboard.md',
])

/** 是否系统内置模板（用户不可改删）：真源 = 该出厂 YAML 顶层 `builtin: true` 标记（loader.templateFlags 派生，小写比对覆盖 Windows 不分大小写文件系统绕过）。
 *  loader 内部改用 templateFlags(key).builtin 直接判定以断开循环依赖；此处保留同名导出供 routes 等外部消费方。 */
export function isBuiltinTemplate(key: string): boolean {
  return templateFlags(key).builtin
}

/** 是否系统内置提示词（相对路径统一 POSIX 斜杠 + 去前缀 ./ + 小写后比对；用户不可改删）。
 *  注：调用方应传入由真实落点反推的规范相对路径，不含 . / .. 冗余段（见 routes 层 resolvePromptPath）。*/
export function isBuiltinPrompt(relName: string): boolean {
  const norm = relName.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  return BUILTIN_PROMPT_NAMES.has(norm)
}
