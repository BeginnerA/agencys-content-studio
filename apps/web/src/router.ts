import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/create', name: 'easy-create', component: () => import('./views/easy-create/index.vue') },
    { path: '/create/:id(\\d+)', name: 'easy-create-detail', component: () => import('./views/easy-create/detail.vue') },
    { path: '/', name: 'projects', component: () => import('./views/projects/index.vue') },
    { path: '/projects/:id(\\d+)', name: 'project', component: () => import('./views/project-detail/index.vue') },
    { path: '/runs/:id(\\d+)', name: 'run', component: () => import('./views/run-detail/index.vue') },
    { path: '/batches/:id(\\d+)', name: 'batch', component: () => import('./views/batch-detail/index.vue') },
    { path: '/stats', name: 'stats', component: () => import('./views/stats/index.vue') },
    { path: '/templates', name: 'templates', component: () => import('./views/templates/index.vue') },
    { path: '/canvas', name: 'canvas', component: () => import('./views/canvas/index.vue') },
    { path: '/creation', name: 'creation', component: () => import('./views/creation/index.vue') },
    { path: '/memories', name: 'memories', component: () => import('./views/memories/index.vue') },
    { path: '/entities', name: 'entities', component: () => import('./views/entities/index.vue') },
    { path: '/style-presets', name: 'style-presets', component: () => import('./views/style-presets/index.vue') },
    // [迁移] AI 配置已从独立菜单并入「设置」；/settings 保留为向后兼容深链，重定向到设置页的「AI 配置」Tab
    { path: '/settings', redirect: (to) => ({ path: '/system', query: { tab: 'ai', ...to.query } }) },
    { path: '/system', name: 'system', component: () => import('./views/system-settings/index.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
