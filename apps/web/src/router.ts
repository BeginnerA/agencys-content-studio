import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'projects', component: () => import('./views/ProjectsView.vue') },
    { path: '/projects/:id(\\d+)', name: 'project', component: () => import('./views/ProjectDetailView.vue') },
    { path: '/runs/:id(\\d+)', name: 'run', component: () => import('./views/RunDetailView.vue') },
    { path: '/templates', name: 'templates', component: () => import('./views/TemplatesView.vue') },
    { path: '/memories', name: 'memories', component: () => import('./views/MemoriesView.vue') },
    { path: '/characters', name: 'characters', component: () => import('./views/CharactersView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
