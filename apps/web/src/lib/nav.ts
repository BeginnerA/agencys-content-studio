// ===== [M21] 主导航定义（App.vue 侧栏与命令面板共享同一数据源） =====

export interface NavItem {
  to: string
  icon: string
  label: string
}

/**
 * 主导航（顺序即展示顺序；「项目」含全局待审阅角标）。
 * 入口收敛（2026-09-13）：「画布」= 创作画布（/creation）；流水线画布（/canvas）为上下文视图，
 * 从运行页「画布视图」/ 模板页「画布」进入——导航不再单列。
 */
export const NAVS: NavItem[] = [
  { to: '/create', icon: 'chat', label: '轻松创作' },
  { to: '/', icon: 'folder', label: '项目' },
  { to: '/creation', icon: 'wand', label: '画布' },
  { to: '/entities', icon: 'users', label: '素材' },
  { to: '/style-presets', icon: 'palette', label: '风格' },
  { to: '/templates', icon: 'doc', label: '模板' },
  { to: '/memories', icon: 'sparkles', label: '记忆' },
  { to: '/stats', icon: 'chart', label: '统计' },
  { to: '/system', icon: 'cog', label: '设置' },
]
