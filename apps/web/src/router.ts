import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('./views/ProjectsView.vue') },
    { path: '/projects/:id(\\d+)', name: 'project', component: () => import('./views/ProjectDetailView.vue') },
    { path: '/runs/:id(\\d+)', name: 'run', component: () => import('./views/RunDetailView.vue') },
    { path: '/batches/:id(\\d+)', name: 'batch', component: () => import('./views/BatchDetailView.vue') },
    { path: '/stats', name: 'stats', component: () => import('./views/StatsView.vue') },
    { path: '/templates', name: 'templates', component: () => import('./views/TemplatesView.vue') },
    { path: '/memories', name: 'memories', component: () => import('./views/MemoriesView.vue') },
    { path: '/entities', name: 'entities', component: () => import('./views/EntitiesView.vue') },
    { path: '/style-presets', name: 'style-presets', component: () => import('./views/StylePresetsView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
