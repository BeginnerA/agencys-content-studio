import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
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
    { path: '/settings', name: 'settings', component: () => import('./views/settings/index.vue') },
    { path: '/system', name: 'system', component: () => import('./views/system-settings/index.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
