/**
 * 项目素材资产状态（BrandSettings 拆分：纯重构，函数体逐字搬移）
 * 项目图片/视频资产列表 + 名称/URL 派生 + 刷新；供 project 选择与 run 继承摘要共用。
 */
import { ref } from 'vue'
import { projectApi } from '../../lib/api'
import type { Asset } from '../../lib/types'

export function useBrandAssets(props: { projectId?: number }) {
  const imgAssets = ref<Asset[]>([])
  const vidAssets = ref<Asset[]>([])

  const assetName = (id: number): string => {
    const a = [...imgAssets.value, ...vidAssets.value].find(
      (it) => it.id === id,
    )
    return a ? `#${a.id} ${a.name}` : `#${id}`
  }
  const assetFileUrl = (id: number): string => {
    const a = [...imgAssets.value, ...vidAssets.value].find(
      (it) => it.id === id,
    )
    return a?.urls.file ?? ''
  }

  async function refreshProjectAssets() {
    const pid = props.projectId ?? 0
    if (pid <= 0) return
    const [imgs, vids] = await Promise.all([
      projectApi.assets(pid, '?kind=image&limit=200'),
      projectApi.assets(pid, '?kind=video&limit=200'),
    ])
    imgAssets.value = imgs.items
    vidAssets.value = vids.items
  }

  return { imgAssets, vidAssets, assetName, assetFileUrl, refreshProjectAssets }
}
