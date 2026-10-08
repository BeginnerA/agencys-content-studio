/**
 * 素材页三 Tab 配置表（自 use-entities.ts 原样抽出，行为零变更）：
 * 角色/场景/道具的标签、占位与空态文案按 kind 适配，单表多态（kind）驱动的展示层真源。
 */
import type { EntityKind } from '../../lib/types'

export interface KindCfg {
  kind: EntityKind
  label: string
  icon: string
  nameLabel: string
  namePh: string
  aliasPh: string
  apLabel: string
  apPh: string
  negPh: string
  summaryPh: string
  refLabel: string
  empty: string
}

export const KINDS: KindCfg[] = [
  {
    kind: 'character',
    label: '角色',
    icon: 'users',
    nameLabel: '角色名',
    namePh: '如：萌宝',
    aliasPh: '如：小宝、团团',
    apLabel: '形象锚定 appearance（出图一致性核心，注入分镜提示词）',
    apPh: '如：三岁半男孩，圆脸大眼，虎头帽红袄，矮胖灵动',
    negPh: '如：成人化五官、替换服装配色',
    summaryPh: '一句话人物设定（可空）',
    refLabel: '定妆照',
    empty:
      '还没有角色。运行角色建档类模板（character_sync）自动入库，或手动新建；定妆照用于出图一致性锚定。',
  },
  {
    kind: 'scene',
    label: '场景',
    icon: 'map',
    nameLabel: '场景名',
    namePh: '如：村口老槐树',
    aliasPh: '如：村口、老树下',
    apLabel: '视觉短语 appearance（空间布局/陈设/色调，注入分镜提示词）',
    apPh: '如：北方村落土坯房，灰瓦屋顶，门口石磨，暖黄夕照',
    negPh: '如：布局改变、陈设增减、色调偏移',
    summaryPh: '一句话说明（地点类型 + 剧情作用，可空）',
    refLabel: '场景参考图',
    empty:
      '还没有场景。运行素材建档模板（entity_sync）自动入库，或手动新建；场景参考图用于空镜一致性锚定。',
  },
  {
    kind: 'prop',
    label: '道具',
    icon: 'cube',
    nameLabel: '道具名',
    namePh: '如：虎头帽',
    aliasPh: '如：小帽子',
    apLabel: '外观描述 appearance（外形/材质/颜色，注入分镜提示词）',
    apPh: '如：大红绸面虎头帽，金线刺绣，两只毛绒虎耳',
    negPh: '如：形状改变、颜色偏移、材质错误',
    summaryPh: '一句话说明（物件属性 + 剧情作用，可空）',
    refLabel: '道具参考图',
    empty:
      '还没有道具。运行素材建档模板（entity_sync）自动入库，或手动新建；道具参考图用于出图一致性锚定。',
  },
]
