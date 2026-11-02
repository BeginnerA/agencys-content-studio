/// <reference types="node" />
/**
 * 画布学习实例 seed · 短剧实战画布构建器（07 两级合成 / 08 三级合成全集 / 09 季级四级合成）。
 *
 * 从 seed-learning-canvases.ts 拆分而来（行为零变更切分）：
 * 复用 seed-learning-api 的 HTTP 工具与领域操作，逐字迁出 07-09 三个大规模画布构建流程。
 */
import {
  addAssetNode,
  addEntityNode,
  addGen,
  addText,
  api,
  group,
  link,
  setSeq,
  setViewport,
  snapshot,
  type Assets,
  type Entities,
  type NodeIds,
} from './seed-learning-api'

/** 07 · 短剧实战：《元气小杨的一天》第1集（多场次 · 两级合成） */
export async function buildCanvas7(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, 40, 40, '📖 使用说明', [
    '学习目标：用画布完整排一集竖屏短剧，体验「两级合成」与全链路分组嵌套。',
    '',
    '① 结构：素材/实体 → 分镜图 → 镜头视频 → 场次合成A/B → 总合成；',
    '② 两级合成：场次合成（compose）的产物可再作为总合成节点的 video 输入（compose → compose 连线）；',
    '③ 场次合成开 align + 字幕 auto + 烧录；总合成只拼场次片、加转场与 BGM（BGM 走 spec.bgmAssetId）；',
    '④ 实体（小杨 / 阿乐 / 咖啡馆 / 黄昏街道）保证角色与场景跨镜头一致，seq 为全片生产顺序；',
    '⑤ 运行节奏：点「运行」先跑就绪节点（分镜图 / 配音）→ 再次运行出镜头视频 → 再运行出场次片 → 最后运行出总合成；',
    '⑥ 交付层：竖版封面图（1024x1536）与 LLM 发布文案；运行需要先配置对应 AI 供应商。',
  ].join('\n'))
  // —— 素材与实体（跨镜头一致性）——
  n.entX = await addEntityNode(cid, 40, 460, '角色 · 小杨', entities.xiaoyang)
  n.entC = await addEntityNode(cid, 40, 780, '场景 · 咖啡馆', entities.cafeScene)
  n.entA = await addEntityNode(cid, 40, 1100, '角色 · 阿乐', entities.ale)
  n.aDusk = await addAssetNode(cid, 40, 1420, '场景参考 · 黄昏街道', assets.duskImg)
  n.bgm = await addAssetNode(cid, 40, 1740, 'BGM · 占位音频（静音 wav）', assets.bgmWav)
  // —— 场次A · 咖啡店内（清晨）：3 镜头 + 3 配音 ——
  n.t1 = await addText(cid, 440, 420, '旁白 · 开场', '清晨，城市刚醒。小杨的咖啡店亮起了第一盏灯。')
  n.t2 = await addText(cid, 440, 740, '台词 · 小杨', '（拉花成形）完美！今天也要元气满满呀。')
  n.t3 = await addText(cid, 440, 1060, '台词 · 阿乐', '老板，老样子——还有，听说你要上新品？')
  n.img1 = await addGen(cid, 840, 420, '分镜1 · 吧台做咖啡', { genKind: 'image', prompt: '竖屏短剧分镜：小杨在咖啡店吧台后制作手冲咖啡，清晨暖光，前景咖啡机虚化，电影感', size: '1024x1536' })
  n.img2 = await addGen(cid, 840, 740, '分镜2 · 拉花特写', { genKind: 'image', prompt: '竖屏特写：咖啡杯中拉花成形，热气升腾，木质桌面与暖光', size: '1024x1536' })
  n.img3 = await addGen(cid, 840, 1060, '分镜3 · 店内交谈中景', { genKind: 'image', prompt: '竖屏中景：小杨与阿乐在吧台前交谈，小杨微笑看向镜头，晨光侧逆光，生活质感', size: '1024x1536' })
  n.au1 = await addGen(cid, 1240, 420, '配音 · 开场旁白', { genKind: 'audio', prompt: '', speed: 1 })
  n.au2 = await addGen(cid, 1240, 740, '配音 · 小杨', { genKind: 'audio', prompt: '', speed: 1 })
  n.au3 = await addGen(cid, 1240, 1060, '配音 · 阿乐', { genKind: 'audio', prompt: '', speed: 1 })
  n.v1 = await addGen(cid, 1640, 420, '镜头1 · 吧台全景推近', { genKind: 'video', prompt: '镜头从全景缓慢推近吧台，人影与蒸汽摇曳', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v2 = await addGen(cid, 1640, 740, '镜头2 · 拉花微距', { genKind: 'video', prompt: '拉花特写微距，蒸汽升腾，轻微手持晃动', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v3 = await addGen(cid, 1640, 1060, '镜头3 · 交谈与微笑', { genKind: 'video', prompt: '小杨与阿乐交谈，小杨抬头看向镜头微笑，镜头轻移', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.ca = await addGen(cid, 2040, 740, '场次合成A · 店内片（对齐+字幕）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, fit: 'pad', fps: 30 })
  // —— 场次B · 黄昏街道（钩子结尾）：2 镜头 + 2 配音 ——
  n.t4 = await addText(cid, 440, 1920, '旁白 · 转折', '黄昏，打烊时分，新品终于定稿——明天，会有惊喜吗？')
  n.t5 = await addText(cid, 440, 2240, '台词 · 小杨 · 钩子', '（看向镜头）明天新品首发，第一个来的，我请。')
  n.img4 = await addGen(cid, 840, 1920, '分镜4 · 推门而出', { genKind: 'image', prompt: '竖屏分镜：小杨推开咖啡店玻璃门走上黄昏街道，逆光背影，门口风铃晃动', size: '1024x1536' })
  n.img5 = await addGen(cid, 840, 2240, '分镜5 · 回眸定格', { genKind: 'image', prompt: '竖屏特写：小杨站在黄昏街头回眸看向镜头，眼神明亮，背景街灯虚化', size: '1024x1536' })
  n.au4 = await addGen(cid, 1240, 1920, '配音 · 转折旁白', { genKind: 'audio', prompt: '', speed: 1 })
  n.au5 = await addGen(cid, 1240, 2240, '配音 · 钩子台词', { genKind: 'audio', prompt: '', speed: 1 })
  n.v4 = await addGen(cid, 1640, 1920, '镜头4 · 跟拍推门', { genKind: 'video', prompt: '跟拍小杨推门走出，风铃晃动，黄昏逆光', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v5 = await addGen(cid, 1640, 2240, '镜头5 · 回眸收尾', { genKind: 'video', prompt: '回眸定格，镜头缓推，氛围收尾', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.cb = await addGen(cid, 2040, 2080, '场次合成B · 结尾片（对齐+字幕）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, fit: 'pad', fps: 30 })
  // —— 交付层：总合成 / 封面 / 运营文案 ——
  n.cf = await addGen(cid, 2440, 1400, '总合成 · 第1集成片（拼场次+BGM）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.8, bgmAssetId: assets.bgmWav, bgmVolume: 0.4, bgmFade: true, fit: 'crop', fps: 30 })
  n.cover = await addGen(cid, 2440, 420, '封面 · 竖版短剧封面', { genKind: 'image', prompt: '竖版短剧封面：元气少女小杨倚在咖啡店吧台边微笑，暖色店招灯箱，上方留白标题区，高级质感', size: '1024x1536' })
  n.t6 = await addText(cid, 2440, 1760, '材料 · 卖点与受众', '短剧《元气小杨的一天》第1集：咖啡店新品首发，结尾钩子「第一个来的我请」；受众 18-30 城市青年；平台：短视频。')
  n.t7 = await addText(cid, 2440, 2080, '指令 · 发布文案', '为短剧第1集写发布文案：不超过 80 字，含标题、2-3 个话题标签与互动引导。')
  n.l1 = await addGen(cid, 2440, 2440, 'LLM · 发布文案生成', { genKind: 'llm', prompt: '', temperature: 0.8, maxTokens: 1500 })
  // —— 连线（场次A）——
  await link(cid, n.entX, n.img1, 'reference')
  await link(cid, n.entC, n.img1, 'reference')
  await link(cid, n.entC, n.img2, 'reference')
  await link(cid, n.entX, n.img3, 'reference')
  await link(cid, n.entA, n.img3, 'reference')
  await link(cid, n.img1, n.v1, 'first_frame')
  await link(cid, n.img2, n.v2, 'first_frame')
  await link(cid, n.img3, n.v3, 'first_frame')
  await link(cid, n.t1, n.au1, 'prompt')
  await link(cid, n.t2, n.au2, 'prompt')
  await link(cid, n.t3, n.au3, 'prompt')
  await link(cid, n.v1, n.ca, 'video')
  await link(cid, n.v2, n.ca, 'video')
  await link(cid, n.v3, n.ca, 'video')
  await link(cid, n.au1, n.ca, 'audio')
  await link(cid, n.au2, n.ca, 'audio')
  await link(cid, n.au3, n.ca, 'audio')
  // —— 连线（场次B）——
  await link(cid, n.entX, n.img4, 'reference')
  await link(cid, n.aDusk, n.img4, 'reference')
  await link(cid, n.entX, n.img5, 'reference')
  await link(cid, n.img4, n.v4, 'first_frame')
  await link(cid, n.img5, n.v5, 'first_frame')
  await link(cid, n.t4, n.au4, 'prompt')
  await link(cid, n.t5, n.au5, 'prompt')
  await link(cid, n.v4, n.cb, 'video')
  await link(cid, n.v5, n.cb, 'video')
  await link(cid, n.au4, n.cb, 'audio')
  await link(cid, n.au5, n.cb, 'audio')
  // —— 连线（交付层，含 compose → compose 两级合成）——
  await link(cid, n.ca, n.cf, 'video')
  await link(cid, n.cb, n.cf, 'video')
  await link(cid, n.entX, n.cover, 'reference')
  await link(cid, n.entC, n.cover, 'reference')
  await link(cid, n.t6, n.l1, 'text')
  await link(cid, n.t7, n.l1, 'prompt')
  // —— 序号（全片生产顺序）——
  const seqPlan: Array<[number, number]> = [
    [n.img1, 1], [n.img2, 2], [n.img3, 3], [n.img4, 4], [n.img5, 5],
    [n.v1, 6], [n.v2, 7], [n.v3, 8], [n.v4, 9], [n.v5, 10],
    [n.ca, 11], [n.cb, 12], [n.cf, 13],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（嵌套：剧集父组 ⊃ 场次分镜/配音/合成 六个子组）——
  const gA1 = await group(cid, '分镜 · 店内', 'blue', [n.img1, n.img2, n.img3, n.v1, n.v2, n.v3])
  const gA2 = await group(cid, '配音 · 店内', 'green', [n.t1, n.t2, n.t3, n.au1, n.au2, n.au3])
  const gA3 = await group(cid, '场内片合成', 'red', [n.ca])
  const gB1 = await group(cid, '分镜 · 黄昏街道', 'blue', [n.img4, n.img5, n.v4, n.v5])
  const gB2 = await group(cid, '配音 · 结尾钩子', 'green', [n.t4, n.t5, n.au4, n.au5])
  const gB3 = await group(cid, '结尾片合成', 'red', [n.cb])
  await group(cid, '《元气小杨的一天》第1集（嵌套父组）', 'amber', undefined, [gA1, gA2, gA3, gB1, gB2, gB3])
  await group(cid, '素材与实体（跨镜头一致性）', 'gray', [n.entX, n.entC, n.entA, n.aDusk, n.bgm])
  await group(cid, '交付与运营', 'purple', [n.cover, n.cf, n.t6, n.t7, n.l1])
  await snapshot(cid, '教学快照 · 第1集初始版')
  await setViewport(cid, 0.4)
}

/** 08 · 短剧实战·全集：4 场次 → 2 幕 → 全集（三级合成链 + 锁版 pin + 双快照 + 编辑链） */
export async function buildCanvas8(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, -1160, 40, '📖 使用说明', [
    '学习目标：四场次短剧全集生产 —— 三级合成链、字幕三模式、BGM 注入、锁版与双快照。',
    '',
    '① 结构：素材/实体 → 分镜图 → 镜头视频 → 场次合成×4 → 幕片×2 → 全集成片（compose 逐级链）；',
    '② 三级合成：c1..c4（场次片）→ m1/m2（幕片）→ f（全集），逐级拼装、逐级转场（dissolve/fadeblack/fade）；',
    '③ 字幕三模式同画布演示：场次层 subtitle=auto 自动生成并烧录；幕层 none（不写字幕）；全集层 subtitle=asset 重钉 SRT 资产；',
    '④ BGM 仅在全集层注入一次（spec.bgmAssetId / bgmVolume / bgmFade），避免逐段重复混音；',
    '⑤ 锁版 pin：镜头8 的 first_frame 输入被锁定为素材「咖啡馆图」（spec.pin={分镜8: 资产}），无视分镜8 当前产物；',
    '⑥ 编辑链（左下实验区）：outpaint 扩图 → inpaint 局部重绘（已挂蒙版素材），产物可替换任一分镜；',
    '⑦ 双快照：v1 结构就绪 / v2 调声后（au8 语速+情绪），可在快照面板对比与恢复；',
    '⑧ 运行节奏：分镜/配音 → 镜头视频 → 场次片 → 幕片 → 全集成片；未跑上游时下游显示「暂无成功产物」属正常。',
  ].join('\n'))
  // —— 素材与实体（跨镜头一致性）——
  n.entX = await addEntityNode(cid, -1160, 520, '角色 · 小杨', entities.xiaoyang)
  n.entA = await addEntityNode(cid, -1160, 840, '角色 · 阿乐', entities.ale)
  n.entC = await addEntityNode(cid, -1160, 1160, '场景 · 咖啡馆', entities.cafeScene)
  n.entD = await addEntityNode(cid, -1160, 1480, '场景 · 黄昏街道', entities.duskStreet)
  n.aCafe = await addAssetNode(cid, -760, 520, '素材 · 咖啡馆图（锁版目标）', assets.cafeImg)
  n.aDusk = await addAssetNode(cid, -760, 840, '素材 · 黄昏街景', assets.duskImg)
  n.aMask = await addAssetNode(cid, -760, 1160, '蒙版 · 局部重绘区域', assets.maskImg)
  n.bgm = await addAssetNode(cid, -760, 1480, 'BGM · 占位音频（全集注入）', assets.bgmWav)
  n.aSrt = await addAssetNode(cid, -760, 1800, '字幕 · 示例 SRT（全集重钉）', assets.srt)
  // —— 场次1 · 清晨咖啡馆（悬念开场）——
  n.t1 = await addText(cid, 80, 400, '旁白 · 开场', '清晨，小杨推开店门——吧台上，配方本不见了。')
  n.t2 = await addText(cid, 80, 720, '台词 · 阿乐', '别急，昨晚最后走的人，说不定看见了什么。')
  n.img1 = await addGen(cid, 480, 400, '分镜1 · 空吧台', { genKind: 'image', prompt: '竖屏分镜：清晨咖啡馆，小杨推门而入，目光落向空荡的吧台，晨光斜射，氛围微妙紧张', size: '1024x1536' })
  n.img2 = await addGen(cid, 480, 720, '分镜2 · 吧台低语', { genKind: 'image', prompt: '竖屏中景：小杨与阿乐在吧台前低声讨论，咖啡热气升腾，浅景深', size: '1024x1536' })
  n.au1 = await addGen(cid, 880, 400, '配音 · 开场旁白', { genKind: 'audio', prompt: '', speed: 0.95 })
  n.au2 = await addGen(cid, 880, 720, '配音 · 阿乐（紧张）', { genKind: 'audio', prompt: '', speed: 1.05, emotion: '紧张——语速略快，尾音压低' })
  n.v1 = await addGen(cid, 1280, 400, '镜头1 · 推门停顿', { genKind: 'video', prompt: '推门进场，小杨停顿半秒，镜头缓推至空吧台', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v2 = await addGen(cid, 1280, 720, '镜头2 · 低语对话', { genKind: 'video', prompt: '两人对话中景，轻微手持晃动，气氛渐紧', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.c1 = await addGen(cid, 1680, 560, '场次合成1 · 清晨片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 场次2 · 店内推理 ——
  n.t3 = await addText(cid, 2280, 400, '台词 · 小杨', '监控？昨晚打烊后我明明锁了门……')
  n.t4 = await addText(cid, 2280, 720, '台词 · 阿乐 · 发现', '等等，柜台边缘有张纸条——「街角见」。')
  n.img3 = await addGen(cid, 2680, 400, '分镜3 · 查看监控', { genKind: 'image', prompt: '竖屏分镜：小杨俯身查看柜台下的旧监控屏，屏幕蓝光映在脸上', size: '1024x1536' })
  n.img4 = await addGen(cid, 2680, 720, '分镜4 · 纸条特写', { genKind: 'image', prompt: '竖屏特写：阿乐捏起柜台边缘的纸条，纸条上是手写小字「街角见」', size: '1024x1536' })
  n.au3 = await addGen(cid, 3080, 400, '配音 · 小杨（疑惑）', { genKind: 'audio', prompt: '', speed: 0.95 })
  n.au4 = await addGen(cid, 3080, 720, '配音 · 阿乐 · 发现', { genKind: 'audio', prompt: '', speed: 0.98 })
  n.v3 = await addGen(cid, 3480, 400, '镜头3 · 屏幕蓝光', { genKind: 'video', prompt: '俯身查看监控，镜头从背后缓推，蓝光闪烁', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v4 = await addGen(cid, 3480, 720, '镜头4 · 纸条微距', { genKind: 'video', prompt: '纸条微距推近，手写小字逐渐清晰', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.c2 = await addGen(cid, 3880, 560, '场次合成2 · 推理片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 场次3 · 街头追踪 ——
  n.t5 = await addText(cid, 80, 1500, '旁白 · 转折', '黄昏，两人循着线索走向街角。')
  n.t6 = await addText(cid, 80, 1820, '台词 · 小杨 · 辨认', '是他？那个总在窗边画画的年轻人！')
  n.img5 = await addGen(cid, 480, 1500, '分镜5 · 走向街角', { genKind: 'image', prompt: '竖屏分镜：小杨与阿乐并肩走在黄昏街道，走向街角，暮色暖橙', size: '1024x1536' })
  n.img6 = await addGen(cid, 480, 1820, '分镜6 · 路灯辨认', { genKind: 'image', prompt: '竖屏中景：街角路灯下，一个年轻背影正翻着本子，小杨在远处辨认', size: '1024x1536' })
  n.au5 = await addGen(cid, 880, 1500, '配音 · 转折旁白', { genKind: 'audio', prompt: '', speed: 1 })
  n.au6 = await addGen(cid, 880, 1820, '配音 · 小杨（焦急）', { genKind: 'audio', prompt: '', speed: 1.1, emotion: '焦急——呼吸感，断句急促' })
  n.v5 = await addGen(cid, 1280, 1500, '镜头5 · 跟拍前行', { genKind: 'video', prompt: '跟拍两人快步前行，暮色光斑流动', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v6 = await addGen(cid, 1280, 1820, '镜头6 · 路灯下定格', { genKind: 'video', prompt: '长焦望向路灯下的背影，轻微变焦试探', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.c3 = await addGen(cid, 1680, 1660, '场次合成3 · 追踪片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 场次4 · 夜归反转 ——
  n.t7 = await addText(cid, 2280, 1500, '旁白 · 反转', '夜里回到店里，配方本静静躺回吧台，夹着一页感谢信。')
  n.t8 = await addText(cid, 2280, 1820, '台词 · 小杨 · 钩子', '（读信，笑）原来他只想给生病的妈妈烤一个生日蛋糕……下周，我们教他。')
  n.img7 = await addGen(cid, 2680, 1500, '分镜7 · 配方本归来', { genKind: 'image', prompt: '竖屏分镜：夜晚咖啡馆，吧台上配方本与一页信纸静静摆放，暖灯聚焦', size: '1024x1536' })
  n.img8 = await addGen(cid, 2680, 1820, '分镜8 · 读信微笑', { genKind: 'image', prompt: '竖屏中景：小杨与阿乐并肩读信，相视而笑，夜灯暖光', size: '1024x1536' })
  n.au7 = await addGen(cid, 3080, 1500, '配音 · 反转旁白', { genKind: 'audio', prompt: '', speed: 0.95 })
  n.au8 = await addGen(cid, 3080, 1820, '配音 · 钩子台词', { genKind: 'audio', prompt: '', speed: 1 })
  n.v7 = await addGen(cid, 3480, 1500, '镜头7 · 推近配方本', { genKind: 'video', prompt: '从店内全景缓推至吧台上的配方本与信纸', duration: 3, resolution: '720p', aspectRatio: '9:16' })
  n.v8 = await addGen(cid, 3480, 1820, '镜头8 · 收尾定格（输入已锁版）', { genKind: 'video', prompt: '两人读信相视而笑，镜头缓拉开，暖光收尾', duration: 3, resolution: '720p', aspectRatio: '9:16', pin: { [String(n.img8)]: assets.cafeImg } })
  n.c4 = await addGen(cid, 3880, 1660, '场次合成4 · 反转片（auto 字幕+烧录）', { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  // —— 后期总装：幕片 → 全集 → 交付 ——
  n.cover = await addGen(cid, 4380, 40, '封面 · 竖版悬疑封面', { genKind: 'image', prompt: '竖版短剧封面：《被偷走的配方》小杨与阿乐并肩站在夜晚咖啡馆门前，手举暖灯，上方留白标题区，悬疑而温暖', size: '1024x1536' })
  n.m1 = await addGen(cid, 4380, 560, '幕片1 · 第一幕（场次1+2）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  n.m2 = await addGen(cid, 4380, 880, '幕片2 · 第二幕（场次3+4）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  n.f = await addGen(cid, 4780, 720, '全集成片 · 三级链终点（asset 字幕+BGM）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.8, bgmAssetId: assets.bgmWav, bgmVolume: 0.35, bgmFade: true, subtitle: 'asset', subtitleAssetId: assets.srt, fit: 'crop', fps: 30 })
  n.t9 = await addText(cid, 4380, 1320, '材料 · 卖点与受众', '短剧《被偷走的配方》（《元气小杨的一天》第2集）：悬疑轻喜，四场次两幕结构；卖点：反转温情结局；受众 18-30 城市青年。')
  n.t10 = await addText(cid, 4380, 1640, '指令 · 发布文案', '为短剧第2集写发布文案：不超过 80 字，含标题、2-3 个话题标签与互动引导。')
  n.l1 = await addGen(cid, 4780, 1480, 'LLM · 发布文案生成', { genKind: 'llm', prompt: '', temperature: 0.9, maxTokens: 2000 })
  // —— 编辑链实验区（outpaint → inpaint，两级编辑）——
  n.eo = await addGen(cid, 80, 2560, '扩图 · outpaint（1.5x）', { genKind: 'image', prompt: '向四周扩展画面，补全店内两侧货架与吊灯，保持光影一致', size: '1024x1024', edit: { mode: 'outpaint', expand: { xScale: 1.5, yScale: 1.5 } } })
  n.ei = await addGen(cid, 480, 2560, '重绘 · inpaint（已配蒙版）', { genKind: 'image', prompt: '把吧台空位补上一本复古配方笔记', size: '1024x1024', edit: { mode: 'inpaint', maskAssetId: assets.maskImg } })
  // —— 连线（场次1）——
  await link(cid, n.entX, n.img1, 'reference')
  await link(cid, n.entC, n.img1, 'reference')
  await link(cid, n.entX, n.img2, 'reference')
  await link(cid, n.entA, n.img2, 'reference')
  await link(cid, n.entC, n.img2, 'reference')
  await link(cid, n.img1, n.v1, 'first_frame')
  await link(cid, n.img2, n.v2, 'first_frame')
  await link(cid, n.t1, n.au1, 'prompt')
  await link(cid, n.t2, n.au2, 'prompt')
  await link(cid, n.v1, n.c1, 'video')
  await link(cid, n.v2, n.c1, 'video')
  await link(cid, n.au1, n.c1, 'audio')
  await link(cid, n.au2, n.c1, 'audio')
  // —— 连线（场次2）——
  await link(cid, n.entX, n.img3, 'reference')
  await link(cid, n.entC, n.img3, 'reference')
  await link(cid, n.entA, n.img4, 'reference')
  await link(cid, n.entC, n.img4, 'reference')
  await link(cid, n.img3, n.v3, 'first_frame')
  await link(cid, n.img4, n.v4, 'first_frame')
  await link(cid, n.t3, n.au3, 'prompt')
  await link(cid, n.t4, n.au4, 'prompt')
  await link(cid, n.v3, n.c2, 'video')
  await link(cid, n.v4, n.c2, 'video')
  await link(cid, n.au3, n.c2, 'audio')
  await link(cid, n.au4, n.c2, 'audio')
  // —— 连线（场次3）——
  await link(cid, n.entX, n.img5, 'reference')
  await link(cid, n.entA, n.img5, 'reference')
  await link(cid, n.entD, n.img5, 'reference')
  await link(cid, n.entX, n.img6, 'reference')
  await link(cid, n.entD, n.img6, 'reference')
  await link(cid, n.img5, n.v5, 'first_frame')
  await link(cid, n.img6, n.v6, 'first_frame')
  await link(cid, n.t5, n.au5, 'prompt')
  await link(cid, n.t6, n.au6, 'prompt')
  await link(cid, n.v5, n.c3, 'video')
  await link(cid, n.v6, n.c3, 'video')
  await link(cid, n.au5, n.c3, 'audio')
  await link(cid, n.au6, n.c3, 'audio')
  // —— 连线（场次4）——
  await link(cid, n.entX, n.img7, 'reference')
  await link(cid, n.entC, n.img7, 'reference')
  await link(cid, n.entX, n.img8, 'reference')
  await link(cid, n.entA, n.img8, 'reference')
  await link(cid, n.entC, n.img8, 'reference')
  await link(cid, n.img7, n.v7, 'first_frame')
  await link(cid, n.img8, n.v8, 'first_frame')
  await link(cid, n.t7, n.au7, 'prompt')
  await link(cid, n.t8, n.au8, 'prompt')
  await link(cid, n.v7, n.c4, 'video')
  await link(cid, n.v8, n.c4, 'video')
  await link(cid, n.au7, n.c4, 'audio')
  await link(cid, n.au8, n.c4, 'audio')
  // —— 连线（后期总装：三级 compose 链 + 封面 + 文案）——
  await link(cid, n.c1, n.m1, 'video')
  await link(cid, n.c2, n.m1, 'video')
  await link(cid, n.c3, n.m2, 'video')
  await link(cid, n.c4, n.m2, 'video')
  await link(cid, n.m1, n.f, 'video')
  await link(cid, n.m2, n.f, 'video')
  await link(cid, n.entX, n.cover, 'reference')
  await link(cid, n.entA, n.cover, 'reference')
  await link(cid, n.entC, n.cover, 'reference')
  await link(cid, n.t9, n.l1, 'text')
  await link(cid, n.t10, n.l1, 'prompt')
  // —— 连线（编辑链：素材 → outpaint → inpaint）——
  await link(cid, n.aCafe, n.eo, 'source')
  await link(cid, n.eo, n.ei, 'source')
  // —— 序号（全片生产顺序 1-23）——
  const seqPlan: Array<[number, number]> = [
    [n.img1, 1], [n.img2, 2], [n.img3, 3], [n.img4, 4], [n.img5, 5], [n.img6, 6], [n.img7, 7], [n.img8, 8],
    [n.v1, 9], [n.v2, 10], [n.v3, 11], [n.v4, 12], [n.v5, 13], [n.v6, 14], [n.v7, 15], [n.v8, 16],
    [n.c1, 17], [n.c2, 18], [n.c3, 19], [n.c4, 20], [n.m1, 21], [n.m2, 22], [n.f, 23],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（三个嵌套结构：两幕父组 + 后期总装父组）——
  const gS1 = await group(cid, '场次1 · 配方失踪', 'blue', [n.t1, n.t2, n.img1, n.img2, n.au1, n.au2, n.v1, n.v2, n.c1])
  const gS2 = await group(cid, '场次2 · 店内推理', 'blue', [n.t3, n.t4, n.img3, n.img4, n.au3, n.au4, n.v3, n.v4, n.c2])
  const gS3 = await group(cid, '场次3 · 街头追踪', 'blue', [n.t5, n.t6, n.img5, n.img6, n.au5, n.au6, n.v5, n.v6, n.c3])
  const gS4 = await group(cid, '场次4 · 夜归反转', 'blue', [n.t7, n.t8, n.img7, n.img8, n.au7, n.au8, n.v7, n.v8, n.c4])
  await group(cid, '第一幕 · 疑云（场次1-2）', 'amber', undefined, [gS1, gS2])
  await group(cid, '第二幕 · 追寻（场次3-4）', 'amber', undefined, [gS3, gS4])
  const gPost1 = await group(cid, '幕片合成（三级链中段）', 'red', [n.m1, n.m2])
  const gPost2 = await group(cid, '全集与交付', 'red', [n.f, n.cover, n.t9, n.t10, n.l1])
  await group(cid, '后期总装（嵌套父组）', 'purple', undefined, [gPost1, gPost2])
  await group(cid, '素材与实体（一致性资产）', 'gray', [n.s, n.entX, n.entA, n.entC, n.entD, n.aCafe, n.aDusk, n.aMask, n.bgm, n.aSrt])
  await group(cid, '编辑增强实验（outpaint → inpaint）', 'teal', [n.eo, n.ei])
  // —— 双快照：v1 结构就绪 → 调声（au8）→ v2（供对比/恢复教学）——
  await snapshot(cid, '教学快照 · v1 全集结构就绪')
  await api('PATCH', `/nodes/${n.au8}`, { spec: { genKind: 'audio', prompt: '', speed: 1.15, emotion: '坚定——语速稍快，尾音上扬' } })
  await snapshot(cid, '教学快照 · v2 调声后（对比 v1）')
  await setViewport(cid, 0.25)
}

/** 09 场次构建器（单镜头迷你场次）：文案→配音 / 分镜→镜头 / 镜头+配音 → 场次合成 */
interface MiniScene {
  t: number
  img: number
  au: number
  v: number
  c: number
}

async function addMiniScene(
  cid: number,
  x: number,
  y: number,
  text: { title: string; body: string },
  img: { title: string; prompt: string },
  au: { title: string; speed?: number; emotion?: string },
  v: { title: string; prompt: string },
  compTitle: string,
  refs: number[],
): Promise<MiniScene> {
  const t = await addText(cid, x, y, text.title, text.body)
  const imgN = await addGen(cid, x + 400, y, img.title, { genKind: 'image', prompt: img.prompt, size: '1024x1536' })
  const auN = await addGen(cid, x + 800, y, au.title, {
    genKind: 'audio',
    prompt: '',
    speed: au.speed ?? 1,
    ...(au.emotion ? { emotion: au.emotion } : {}),
  })
  const vN = await addGen(cid, x + 1200, y, v.title, { genKind: 'video', prompt: v.prompt, duration: 3, resolution: '720p', aspectRatio: '9:16' })
  const cN = await addGen(cid, x + 1600, y, compTitle, { genKind: 'compose', prompt: '', align: true, subtitle: 'auto', burnSubtitles: true, transition: 'dissolve', transitionDuration: 0.3, fit: 'pad', fps: 30 })
  for (const r of refs) await link(cid, r, imgN, 'reference')
  await link(cid, t, auN, 'prompt')
  await link(cid, imgN, vN, 'first_frame')
  await link(cid, vN, cN, 'video')
  await link(cid, auN, cN, 'audio')
  return { t, img: imgN, au: auN, v: vN, c: cN }
}

/** 09 · 季级实战：2 集 → 10 场次 → 四级合成（场次 → 幕 → 集 → 季） */
export async function buildCanvas9(cid: number, assets: Assets, entities: Entities): Promise<void> {
  const n: NodeIds = {}
  n.s = await addText(cid, -1200, 40, '📖 使用说明', [
    '学习目标：从「一集」升级到「一季」——多集结构、更深合成层级与更大场次规模。',
    '',
    '① 三档规模升级（对照 08 画布）：场次 10 > 4、幕 5 > 2、集 2 > 1、合成链 4 级 > 3 级；',
    '② 多集系列：第1集（6 场次 3 幕）与第2集（4 场次 2 幕）各自独立成链，最终在季总片汇合；',
    '③ 四级合成：场次合成 ×10 → 幕片 ×5 → 集片 ×2 → 季总片（compose 逐级链，每级各有转场策略）；',
    '④ 季级统一层：BGM 与字幕仅在季总片注入一次（避免逐集重复混音），配季封面 / 下季预告 / 季宣发文案；',
    '⑤ 嵌套加深：场次组 ⊂ 幕组 ⊂ 集组（三层嵌套；08 为两层），组内折叠后结构一目了然；',
    '⑥ 运行节奏：分镜/配音 → 镜头视频 → 场次片 → 幕片 → 集片 → 季总片；未跑上游时下游显示「暂无成功产物」属正常。',
  ].join('\n'))
  // —— 素材与实体（跨集一致性）——
  n.entX = await addEntityNode(cid, -1200, 520, '角色 · 小杨', entities.xiaoyang)
  n.entA = await addEntityNode(cid, -1200, 840, '角色 · 阿乐', entities.ale)
  n.entY = await addEntityNode(cid, -1200, 1160, '角色 · 小宇（本季新角色）', entities.xiaoyu)
  n.entC = await addEntityNode(cid, -1200, 1480, '场景 · 咖啡馆', entities.cafeScene)
  n.entD = await addEntityNode(cid, -1200, 1800, '场景 · 黄昏街道', entities.duskStreet)
  n.bgm = await addAssetNode(cid, -1200, 2180, 'BGM · 占位音频（季级注入）', assets.bgmWav)
  n.aSrt = await addAssetNode(cid, -1200, 2480, '字幕 · 示例 SRT（季级重钉）', assets.srt)
  // —— 第1集《特殊的学徒》：6 场次 → 3 幕 ——
  // 第一幕 · 请求（场次1-2）
  const s11 = await addMiniScene(cid, 80, 400,
    { title: '台词 · 小宇（请求）', body: '小杨姐……我想学做蛋糕。下周是妈妈的生日，我想亲手做一个给她。' },
    { title: '分镜1 · 街角请求', prompt: '竖屏分镜：黄昏街角，小宇背着画板鼓起勇气拦住刚打烊的小杨，紧张又期待，暮色暖橙' },
    { title: '配音 · 小宇（请求）', speed: 1.0, emotion: '紧张——语速略快，气声明显' },
    { title: '镜头1 · 街角对话', prompt: '跟拍小宇文涩开口，暮色光斑流动，镜头轻推近' },
    '场次合成1 · 请求片（auto 字幕+烧录）',
    [n.entX, n.entY, n.entD])
  const s12 = await addMiniScene(cid, 2080, 400,
    { title: '台词 · 小杨（应允）', body: '好啊——不过做蛋糕没那么简单。明天打烊后，来店里。' },
    { title: '分镜2 · 吧台应允', prompt: '竖屏中景：咖啡馆吧台前，小杨笑着点头应允，阿乐在一旁鼓掌，暖灯氛围' },
    { title: '配音 · 小杨（温和）', speed: 0.95 },
    { title: '镜头2 · 店内交谈', prompt: '吧台对话中景，暖光摇曳，镜头轻摇' },
    '场次合成2 · 应允片（auto 字幕+烧录）',
    [n.entX, n.entC])
  // 第二幕 · 磨练（场次3-4）
  const s13 = await addMiniScene(cid, 80, 1000,
    { title: '台词 · 阿乐（打趣）', body: '手腕要稳，别甩出去——哈哈，奶油都上墙了！' },
    { title: '分镜3 · 奶油乱飞', prompt: '竖屏特写：厨房里小宇手忙脚乱打发奶油，奶油飞溅到围裙，阿乐大笑' },
    { title: '配音 · 阿乐（打趣）', speed: 1.05, emotion: '打趣——语调上扬，带笑' },
    { title: '镜头3 · 厨房手忙脚乱', prompt: '厨房轻喜剧节奏，镜头随奶油飞溅轻甩' },
    '场次合成3 · 磨练片（auto 字幕+烧录）',
    [n.entY, n.entC])
  const s14 = await addMiniScene(cid, 2080, 1000,
    { title: '台词 · 小宇（沮丧）', body: '又糊了……我是不是特别笨？' },
    { title: '分镜4 · 烤糊的蛋糕', prompt: '竖屏近景：烤盘上焦黑的蛋糕胚冒着焦烟，小宇低头垂肩，灯光转冷' },
    { title: '配音 · 小宇（沮丧）', speed: 0.9, emotion: '沮丧——语速慢，气息低' },
    { title: '镜头4 · 烤箱前的沉默', prompt: '固定机位，焦烟缓缓升起，人物沉默' },
    '场次合成4 · 失败片（auto 字幕+烧录）',
    [n.entY, n.entC])
  // 第三幕 · 渐成（场次5-6）
  const s15 = await addMiniScene(cid, 80, 1600,
    { title: '旁白 · 深夜', body: '深夜的咖啡馆还亮着灯——失败率的尽头，是越来越稳的手腕。' },
    { title: '分镜5 · 深夜练习', prompt: '竖屏分镜：深夜咖啡馆后厨暖灯下，小宇独自反复练习打发，小杨在门口默默注视' },
    { title: '配音 · 深夜旁白', speed: 0.95 },
    { title: '镜头5 · 深夜灯光', prompt: '从窗外夜街推近到灯火通明的咖啡馆窗户，缓慢推进' },
    '场次合成5 · 深夜片（auto 字幕+烧录）',
    [n.entY, n.entC])
  const s16 = await addMiniScene(cid, 2080, 1600,
    { title: '台词 · 小杨（鼓励）', body: '看，这次发得刚刚好——明天，就是正式的了。' },
    { title: '分镜6 · 成功的蛋糕胚', prompt: '竖屏特写：金黄的蛋糕胚出炉，小宇与小杨相视而笑，晨光透窗' },
    { title: '配音 · 小杨（鼓励）', speed: 1.0 },
    { title: '镜头6 · 出炉瞬间', prompt: '出炉瞬间轻推，热气升腾，晨光渐亮' },
    '场次合成6 · 渐成片（auto 字幕+烧录）',
    [n.entX, n.entY, n.entC])
  // —— 第2集《生日快乐》：4 场次 → 2 幕 ——
  const s21 = await addMiniScene(cid, 80, 2200,
    { title: '旁白 · 前夜', body: '生日前一晚，三个人把咖啡馆布置成了小小的生日现场。' },
    { title: '分镜7 · 布置现场', prompt: '竖屏分镜：夜晚咖啡馆挂起暖白小灯与手写横幅，三人踩着凳子在布置' },
    { title: '配音 · 前夜旁白', speed: 0.95 },
    { title: '镜头7 · 挂起小灯', prompt: '仰拍视角：暖灯串渐次点亮，镜头缓摇' },
    '场次合成7 · 前夜片（auto 字幕+烧录）',
    [n.entC, n.entY])
  const s22 = await addMiniScene(cid, 2080, 2200,
    { title: '台词 · 小宇（专注）', body: '妈妈喜欢草莓……中间这朵奶油花，是我画过的第一张画。' },
    { title: '分镜8 · 装饰蛋糕', prompt: '竖屏特写：小宇手挤奶油花，蛋糕上摆满草莓，专注的侧脸被暖灯勾勒' },
    { title: '配音 · 小宇（专注）', speed: 0.95 },
    { title: '镜头8 · 裱花特写', prompt: '微距拍裱花过程，奶油花逐渐成形' },
    '场次合成8 · 装饰片（auto 字幕+烧录）',
    [n.entY, n.entC])
  const s23 = await addMiniScene(cid, 80, 2800,
    { title: '台词 · 小杨（神秘）', body: '阿姨，这边请——有个人，等您很久了。' },
    { title: '分镜9 · 妈妈进门', prompt: '竖屏分镜：咖啡馆门口，小杨引着一位女士进门，小宇在烛光后紧张站立' },
    { title: '配音 · 小杨（神秘）', speed: 1.0 },
    { title: '镜头9 · 推门瞬间', prompt: '门铃响起，镜头从烛光蛋糕摇向门口，轻微晃动' },
    '场次合成9 · 惊喜片（auto 字幕+烧录）',
    [n.entX, n.entC])
  const s24 = await addMiniScene(cid, 2080, 2800,
    { title: '台词 · 妈妈（哽咽）', body: '傻孩子……这是妈妈这些年，收到过最好的生日蛋糕。' },
    { title: '分镜10 · 拥抱定格', prompt: '竖屏中景：烛光中妈妈红着眼眶抱住小宇，小杨与阿乐在旁微笑，暖光收尾' },
    { title: '配音 · 妈妈（哽咽）', speed: 0.9, emotion: '哽咽——气息断续，尾音发颤' },
    { title: '镜头10 · 拥抱定格', prompt: '环绕半圈后定格合成合影，灯光渐暖' },
    '场次合成10 · 结局片（auto 字幕+烧录）',
    [n.entY, n.entC])
  // —— 四级链中后段：幕片 ×5 → 集片 ×2 → 季总片 ——
  const m11 = await addGen(cid, 4080, 400, '幕片1-1 · 第1集第一幕（场次1-2）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m12 = await addGen(cid, 4080, 1000, '幕片1-2 · 第1集第二幕（场次3-4）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m13 = await addGen(cid, 4080, 1600, '幕片1-3 · 第1集第三幕（场次5-6）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m21 = await addGen(cid, 4080, 2200, '幕片2-1 · 第2集第一幕（场次1-2）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const m22 = await addGen(cid, 4080, 2800, '幕片2-2 · 第2集第二幕（场次3-4）', { genKind: 'compose', prompt: '', transition: 'fadeblack', transitionDuration: 0.6, fit: 'crop', fps: 30 })
  const ep1 = await addGen(cid, 4480, 1000, '集片 · 第1集成片（三幕联排）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5, fit: 'crop', fps: 30 })
  const ep2 = await addGen(cid, 4480, 2500, '集片 · 第2集成片（两幕联排）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 0.5, fit: 'crop', fps: 30 })
  n.season = await addGen(cid, 4880, 1750, '季总片 · 四级链终点（两集联播+季 BGM/字幕）', { genKind: 'compose', prompt: '', transition: 'fade', transitionDuration: 1, bgmAssetId: assets.bgmWav, bgmVolume: 0.35, bgmFade: true, subtitle: 'asset', subtitleAssetId: assets.srt, fit: 'crop', fps: 30 })
  n.cover = await addGen(cid, 4880, 400, '季封面 · 竖版', { genKind: 'image', prompt: '竖版季封面：《元气小杨的一天》第1季——咖啡馆暖灯下三人合影，蛋糕与烛光，上方留白标题区，治愈质感', size: '1024x1536' })
  n.trailer = await addGen(cid, 4880, 760, '下季预告 · 钩子', { genKind: 'video', prompt: '竖版预告：镜头掠过墙上的三人合影，缓缓定格在一把空椅子上，灯光渐暗', duration: 4, resolution: '720p', aspectRatio: '9:16' })
  n.tm = await addText(cid, 4880, 2300, '材料 · 全季卖点与受众', '短剧《元气小杨的一天》第1季（第1-2集）：两集连播，治愈系成长故事；卖点：师徒线 + 生日惊喜反转；受众 18-30 城市青年；平台：短视频。')
  n.tp = await addText(cid, 4880, 2620, '指令 · 季宣发文案', '为本季写宣发文案：不超过 100 字，含季标题、2-3 个话题标签与追更引导。')
  n.l1 = await addGen(cid, 4880, 2940, 'LLM · 季宣发文案生成', { genKind: 'llm', prompt: '', temperature: 0.9, maxTokens: 2000 })
  // —— 连线（四级合成链：场次 → 幕 → 集 → 季）——
  await link(cid, s11.c, m11, 'video')
  await link(cid, s12.c, m11, 'video')
  await link(cid, s13.c, m12, 'video')
  await link(cid, s14.c, m12, 'video')
  await link(cid, s15.c, m13, 'video')
  await link(cid, s16.c, m13, 'video')
  await link(cid, s21.c, m21, 'video')
  await link(cid, s22.c, m21, 'video')
  await link(cid, s23.c, m22, 'video')
  await link(cid, s24.c, m22, 'video')
  await link(cid, m11, ep1, 'video')
  await link(cid, m12, ep1, 'video')
  await link(cid, m13, ep1, 'video')
  await link(cid, m21, ep2, 'video')
  await link(cid, m22, ep2, 'video')
  await link(cid, ep1, n.season, 'video')
  await link(cid, ep2, n.season, 'video')
  // —— 连线（季级交付：封面 / 预告 / 宣发文案）——
  await link(cid, n.entX, n.cover, 'reference')
  await link(cid, n.entY, n.cover, 'reference')
  await link(cid, n.entC, n.cover, 'reference')
  await link(cid, n.entC, n.trailer, 'reference')
  await link(cid, n.tm, n.l1, 'text')
  await link(cid, n.tp, n.l1, 'prompt')
  // —— 序号（全季生产顺序 1-38）——
  const seqPlan: Array<[number, number]> = [
    [s11.img, 1], [s12.img, 2], [s13.img, 3], [s14.img, 4], [s15.img, 5], [s16.img, 6],
    [s21.img, 7], [s22.img, 8], [s23.img, 9], [s24.img, 10],
    [s11.v, 11], [s12.v, 12], [s13.v, 13], [s14.v, 14], [s15.v, 15], [s16.v, 16],
    [s21.v, 17], [s22.v, 18], [s23.v, 19], [s24.v, 20],
    [s11.c, 21], [s12.c, 22], [s13.c, 23], [s14.c, 24], [s15.c, 25], [s16.c, 26],
    [s21.c, 27], [s22.c, 28], [s23.c, 29], [s24.c, 30],
    [m11, 31], [m12, 32], [m13, 33], [m21, 34], [m22, 35],
    [ep1, 36], [ep2, 37], [n.season, 38],
  ]
  for (const [id, s] of seqPlan) await setSeq(id, s)
  // —— 分组（三层嵌套：场次 ⊂ 幕 ⊂ 集；季级交付独立成组）——
  const gS11 = await group(cid, '第1集 · 场次1 · 街角请求', 'blue', [s11.t, s11.img, s11.au, s11.v, s11.c])
  const gS12 = await group(cid, '第1集 · 场次2 · 店内应允', 'blue', [s12.t, s12.img, s12.au, s12.v, s12.c])
  const gS13 = await group(cid, '第1集 · 场次3 · 第一次打发', 'blue', [s13.t, s13.img, s13.au, s13.v, s13.c])
  const gS14 = await group(cid, '第1集 · 场次4 · 第一炉失败', 'blue', [s14.t, s14.img, s14.au, s14.v, s14.c])
  const gS15 = await group(cid, '第1集 · 场次5 · 深夜练习', 'blue', [s15.t, s15.img, s15.au, s15.v, s15.c])
  const gS16 = await group(cid, '第1集 · 场次6 · 渐入佳境', 'blue', [s16.t, s16.img, s16.au, s16.v, s16.c])
  const gS21 = await group(cid, '第2集 · 场次1 · 生日前夜', 'blue', [s21.t, s21.img, s21.au, s21.v, s21.c])
  const gS22 = await group(cid, '第2集 · 场次2 · 精心装饰', 'blue', [s22.t, s22.img, s22.au, s22.v, s22.c])
  const gS23 = await group(cid, '第2集 · 场次3 · 生日惊喜', 'blue', [s23.t, s23.img, s23.au, s23.v, s23.c])
  const gS24 = await group(cid, '第2集 · 场次4 · 拥抱与约定', 'blue', [s24.t, s24.img, s24.au, s24.v, s24.c])
  const gM11 = await group(cid, '第1集 · 第一幕 · 请求（场次1-2）', 'amber', undefined, [gS11, gS12])
  const gM12 = await group(cid, '第1集 · 第二幕 · 磨练（场次3-4）', 'amber', undefined, [gS13, gS14])
  const gM13 = await group(cid, '第1集 · 第三幕 · 渐成（场次5-6）', 'amber', undefined, [gS15, gS16])
  const gM21 = await group(cid, '第2集 · 第一幕 · 准备（场次1-2）', 'amber', undefined, [gS21, gS22])
  const gM22 = await group(cid, '第2集 · 第二幕 · 惊喜（场次3-4）', 'amber', undefined, [gS23, gS24])
  await group(cid, '第1集《特殊的学徒》（嵌套：集 ⊃ 幕 ⊃ 场次）', 'teal', undefined, [gM11, gM12, gM13])
  await group(cid, '第2集《生日快乐》（嵌套：集 ⊃ 幕 ⊃ 场次）', 'teal', undefined, [gM21, gM22])
  await group(cid, '幕片合成（四级链 · 第2级）', 'red', [m11, m12, m13, m21, m22])
  await group(cid, '集片 · 季总装（四级链 · 第3-4级）', 'purple', [ep1, ep2, n.season, n.cover, n.trailer, n.tm, n.tp, n.l1])
  await group(cid, '素材与实体（跨集一致性）', 'gray', [n.s, n.entX, n.entA, n.entY, n.entC, n.entD, n.bgm, n.aSrt])
  // —— 双快照：v1 季结构就绪 → 调声（s16 配音）→ v2（供对比/恢复教学）——
  await snapshot(cid, '教学快照 · v1 季结构就绪')
  await api('PATCH', `/nodes/${s16.au}`, { spec: { genKind: 'audio', prompt: '', speed: 1.08, emotion: '欣慰——语速缓和，尾音带笑意' } })
  await snapshot(cid, '教学快照 · v2 调声后（对比 v1）')
  await setViewport(cid, 0.22)
}
