<script setup lang="ts">
import BrandSettings from '../../components/brand/BrandSettings.vue'
import BrandPreview from '../../components/brand/BrandPreview.vue'
import type { ProjectDetailApi } from './use-project-detail'
const props = defineProps<{ s: ProjectDetailApi }>()
const {
  projectId,
  activeTab,
  projBrandSnap,
  projWmFileSnap,
  projIntroFileSnap,
  projOutroFileSnap,
  projWmPreviewTs,
  onProjectPreview,
  loadCore,
} = props.s
</script>

<template>
  <section
    v-show="activeTab === 'brand'"
    role="tabpanel"
    aria-labelledby="ptab-brand"
    class="proj-brand"
  >
    <div class="proj-brand-form">
      <BrandSettings
        scope="project"
        :project-id="projectId"
        @changed="loadCore({ silent: true })"
        @preview="onProjectPreview"
      />
    </div>
    <aside class="proj-brand-preview">
      <BrandPreview
        :brand="projBrandSnap"
        :wm-file="projWmFileSnap"
        :wm-preview-ts="projWmPreviewTs"
        :intro-file="projIntroFileSnap"
        :outro-file="projOutroFileSnap"
      />
    </aside>
  </section>
</template>

<style scoped>
.proj-brand {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 24px;
  align-items: start;
}

.proj-brand-form {
  min-width: 0;
}

.proj-brand-preview {
  position: sticky;
  top: 16px;
}

@media (max-width: 960px) {
  .proj-brand {
    grid-template-columns: 1fr;
  }
  .proj-brand-preview {
    position: static;
  }
}
</style>
