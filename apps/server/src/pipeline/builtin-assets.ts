/**
 * 内置资产清单（系统工厂模板 / 提示词的唯一真源）。
 *
 * 语义：随产品发布、写在出厂 workspace/ 里的模板与提示词，属于「系统内置」——
 * 用户只读，不可修改、不可删除（服务端 routes + loader 据此拒绝，前端据此锁定编辑/删除入口）。
 * 用户在运行期新建 / 另存为副本 / 画布编辑落盘的资产不在此清单，视为「自定义」，可随意改删。
 *
 * 维护：新增一份出厂模板或提示词时，把它的 key / 相对路径同步进下面的集合。
 * 漏项的后果是「该出厂资产变成可改」（偏宽松，不会破坏数据）；多项则命中不存在的文件，天然无害。
 */

/** 出厂内置模板 key（workspace/templates/*.yaml，共 19 份） */
export const BUILTIN_TEMPLATE_KEYS: ReadonlySet<string> = new Set<string>([
  'article-clip',
  'easy-dialogue',
  'easy-dialogue-review',
  'easy-video',
  'easy-video-review',
  'image-reverse',
  'mengbao-episode',
  'note-clip',
  'novel-adapt',
  'novel-audit',
  'platform-adapt',
  'quick-video',
  'review-restock',
  'series-setup',
  'talking-clip',
  'topic-radar',
  'translate-export',
  'video-plan',
  'video-reverse',
])

/** 出厂内置提示词相对路径（workspace/prompts/*.md，POSIX 斜杠，共 47 份） */
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

/** 是否系统内置模板（用户不可改删）；键集均小写，小写比对以覆盖 Windows 不分大小写文件系统的绕过 */
export function isBuiltinTemplate(key: string): boolean {
  return BUILTIN_TEMPLATE_KEYS.has(key.toLowerCase())
}

/** 是否系统内置提示词（相对路径统一 POSIX 斜杠 + 去前缀 ./ + 小写后比对；用户不可改删）。
 *  注：调用方应传入由真实落点反推的规范相对路径，不含 . / .. 冗余段（见 routes 层 resolvePromptPath）。*/
export function isBuiltinPrompt(relName: string): boolean {
  const norm = relName.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  return BUILTIN_PROMPT_NAMES.has(norm)
}
