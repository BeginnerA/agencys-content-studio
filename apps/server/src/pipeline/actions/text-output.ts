/**
 * 输出契约校验（从 ai-text.ts 原样抽出，行为零变更；ai-text.ts 仅 re-export 保持既有引用路径）。
 * 连续性调用复用同一校验入口（services/continuity/invocation）。
 */

/**
 * 输出契约校验（导出供探针直接断言，无需 LLM）：
 * storyboard-json（shots 数组 + image_prompt）/ lines-json（lines 数组 + text/est_ms + v2 speaker/voice_hint/emotion_hint）
 * / characters-json（characters 数组 + name/appearance + 可选 aliases/summary/negative/voice/voice_desc/ref_prompt）
 * / set-json（scenes+props 至少一数组非空 + name/appearance）；
 * 返回条目数（非校验格式→ 0）；错误消息口径与既有实现一致。
 */
export function validateTextOutput(content: string, format: string): number {
  if (format === 'storyboard-json') {
    const obj = JSON.parse(extractJson(content)) as { shots?: unknown }
    if (!Array.isArray(obj.shots) || obj.shots.length === 0) {
      throw new Error(`分镜 JSON 不合法（缺 shots 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const shot of obj.shots as Array<Record<string, unknown>>) {
      if (typeof shot['image_prompt'] !== 'string' || !shot['image_prompt']) {
        throw new Error(`分镜 JSON 不合法：shot ${String(shot['id'] ?? '?')} 缺 image_prompt`)
      }
    }
    return obj.shots.length
  }
  if (format === 'lines-json') {
    const obj = JSON.parse(extractJson(content)) as { lines?: unknown }
    if (!Array.isArray(obj.lines) || obj.lines.length === 0) {
      throw new Error(`台词 JSON 不合法（缺 lines 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const rec of obj.lines as Array<Record<string, unknown>>) {
      if (typeof rec['text'] !== 'string' || !String(rec['text']).trim()) {
        throw new Error(`台词 JSON 不合法：句 ${String(rec['id'] ?? '?')} 缺 text`)
      }
      if (rec['est_ms'] !== undefined && (typeof rec['est_ms'] !== 'number' || rec['est_ms'] <= 0)) {
        throw new Error(`台词 JSON 不合法：句 ${String(rec['id'] ?? '?')} 的 est_ms 需为正数`)
      }
      // v2 可选台词字段（tts 声线/情绪链；存在时必须为非空字符串）
      for (const key of ['speaker', 'voice_hint', 'emotion_hint']) {
        const v = rec[key]
        if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
          throw new Error(`台词 JSON 不合法：句 ${String(rec['id'] ?? '?')} 的 ${key} 需为非空字符串`)
        }
      }
    }
    return obj.lines.length
  }
  if (format === 'characters-json') {
    const obj = JSON.parse(extractJson(content)) as { characters?: unknown }
    if (!Array.isArray(obj.characters) || obj.characters.length === 0) {
      throw new Error(`角色档案 JSON 不合法（缺 characters 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const rec of obj.characters as Array<Record<string, unknown>>) {
      if (typeof rec['name'] !== 'string' || !rec['name'].trim()) {
        throw new Error('角色档案 JSON 不合法：存在缺 name 的角色项')
      }
      const who = rec['name']
      if (typeof rec['appearance'] !== 'string' || !rec['appearance'].trim()) {
        throw new Error(`角色档案 JSON 不合法：角色 ${who} 缺 appearance`)
      }
      const aliases = rec['aliases']
      if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((x: unknown) => typeof x !== 'string' || !x.trim()))) {
        throw new Error(`角色档案 JSON 不合法：角色 ${who} 的 aliases 需为非空字符串数组`)
      }
      for (const key of ['summary', 'negative', 'voice', 'voice_desc']) {
        if (rec[key] !== undefined && typeof rec[key] !== 'string') {
          throw new Error(`角色档案 JSON 不合法：角色 ${who} 的 ${key} 需为字符串`)
        }
      }
      if (
        rec['ref_prompt'] !== undefined &&
        !(typeof rec['ref_prompt'] === 'string' || (Array.isArray(rec['ref_prompt']) && rec['ref_prompt'].every((x: unknown) => typeof x === 'string')))
      ) {
        throw new Error(`角色档案 JSON 不合法：角色 ${who} 的 ref_prompt 需为字符串或字符串数组`)
      }
    }
    return obj.characters.length
  }
  if (format === 'set-json') {
    const obj = JSON.parse(extractJson(content)) as { scenes?: unknown; props?: unknown }
    const scenes = Array.isArray(obj.scenes) ? obj.scenes : []
    const props = Array.isArray(obj.props) ? obj.props : []
    if (scenes.length === 0 && props.length === 0) {
      throw new Error(`场景道具档案 JSON 不合法（scenes/props 双空）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const [label, list] of [['场景', scenes], ['道具', props]] as const) {
      for (const rec of list as Array<Record<string, unknown>>) {
        if (typeof rec['name'] !== 'string' || !rec['name'].trim()) {
          throw new Error(`场景道具档案 JSON 不合法：存在缺 name 的${label}项`)
        }
        if (typeof rec['appearance'] !== 'string' || !rec['appearance'].trim()) {
          throw new Error(`场景道具档案 JSON 不合法：${label} ${rec['name']} 缺 appearance`)
        }
        const aliases = rec['aliases']
        if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((x: unknown) => typeof x !== 'string' || !x.trim()))) {
          throw new Error(`场景道具档案 JSON 不合法：${label} ${rec['name']} 的 aliases 需为非空字符串数组`)
        }
        for (const key of ['summary', 'negative']) {
          if (rec[key] !== undefined && typeof rec[key] !== 'string') {
            throw new Error(`场景道具档案 JSON 不合法：${label} ${rec['name']} 的 ${key} 需为字符串`)
          }
        }
      }
    }
    return scenes.length + props.length
  }
  if (format === 'event-json') {
    const obj = JSON.parse(extractJson(content)) as { chapter_index?: unknown; core_event?: unknown }
    if (typeof obj.chapter_index !== 'number' || !Number.isInteger(obj.chapter_index)) {
      throw new Error(`事件 JSON 不合法：chapter_index 需为整数。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    if (typeof obj.core_event !== 'string' || !obj.core_event.trim()) {
      throw new Error(`事件 JSON 不合法：core_event 需为非空字符串（第 ${obj.chapter_index} 章）`)
    }
    return 1
  }
  if (format === 'graph-json') {
    const obj = JSON.parse(extractJson(content)) as { characters?: unknown; key_events?: unknown }
    if (!Array.isArray(obj.key_events) || obj.key_events.length === 0) {
      throw new Error(`事件图谱 JSON 不合法（缺 key_events 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const ev of obj.key_events as Array<Record<string, unknown>>) {
      if (typeof ev['name'] !== 'string' || !ev['name'].trim()) {
        throw new Error('事件图谱 JSON 不合法：存在缺 name 的关键事件')
      }
      if (
        !Array.isArray(ev['chapters']) ||
        ev['chapters'].length === 0 ||
        ev['chapters'].some((n: unknown) => typeof n !== 'number' || !Number.isInteger(n))
      ) {
        throw new Error(`事件图谱 JSON 不合法：事件「${String(ev['name'])}」的 chapters 需为非空整数数组`)
      }
    }
    if (obj.characters !== undefined) {
      if (!Array.isArray(obj.characters)) throw new Error('事件图谱 JSON 不合法：characters 需为数组')
      for (const c of obj.characters as Array<Record<string, unknown>>) {
        if (typeof c['name'] !== 'string' || !c['name'].trim()) {
          throw new Error('事件图谱 JSON 不合法：存在缺 name 的角色')
        }
      }
    }
    return obj.key_events.length
  }
  if (format === 'plan-json') {
    const obj = JSON.parse(extractJson(content)) as { episodes?: unknown }
    if (!Array.isArray(obj.episodes) || obj.episodes.length === 0) {
      throw new Error(`分集规划 JSON 不合法（缺 episodes 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    for (const ep of obj.episodes as Array<Record<string, unknown>>) {
      if (typeof ep['ep'] !== 'number' || !Number.isInteger(ep['ep'])) {
        throw new Error('分集规划 JSON 不合法：episodes 存在非整数 ep')
      }
      if (!Array.isArray(ep['chapters']) || ep['chapters'].length === 0) {
        throw new Error(`分集规划 JSON 不合法：第 ${String(ep['ep'])} 集缺 chapters 非空数组`)
      }
      if (typeof ep['synopsis'] !== 'string' || !ep['synopsis'].trim()) {
        throw new Error(`分集规划 JSON 不合法：第 ${String(ep['ep'])} 集缺 synopsis`)
      }
      if (ep['chapter_events'] !== undefined) {
        if (!Array.isArray(ep['chapter_events'])) {
          throw new Error(`分集规划 JSON 不合法：第 ${String(ep['ep'])} 集 chapter_events 需为数组`)
        }
        for (const ce of ep['chapter_events'] as Array<Record<string, unknown>>) {
          if (typeof ce['chapter_index'] !== 'number' || !Number.isInteger(ce['chapter_index'])) {
            throw new Error(`分集规划 JSON 不合法：第 ${String(ep['ep'])} 集 chapter_events 存在非整数 chapter_index`)
          }
          if (typeof ce['core_event'] !== 'string' || !ce['core_event'].trim()) {
            throw new Error(`分集规划 JSON 不合法：第 ${String(ep['ep'])} 集 chapter_events 存在缺 core_event 的项`)
          }
        }
      }
    }
    return obj.episodes.length
  }
  if (format === 'monetization-json') {
    // 商业结构：逐集悬念标记为剧情设计产物（真实付费与否由发布平台决定，此处不设真实付费门禁参数）
    const obj = JSON.parse(extractJson(content)) as { episode_count?: unknown; episodes?: unknown }
    if (!Array.isArray(obj.episodes) || obj.episodes.length === 0) {
      throw new Error(`商业结构 JSON 不合法（缺 episodes 数组）。返回开头 200 字符：${content.slice(0, 200)}`)
    }
    const epsArr = obj.episodes as Array<Record<string, unknown>>
    if (typeof obj.episode_count === 'number' && obj.episode_count !== obj.episodes.length) {
      throw new Error(`商业结构 JSON 不合法：episode_count=${String(obj.episode_count)} 与 episodes 数量 ${obj.episodes.length} 不一致`)
    }
    const eps = new Set<number>()
    for (const ep of epsArr) {
      if (typeof ep['ep'] !== 'number' || !Number.isInteger(ep['ep']) || ep['ep'] < 1) {
        throw new Error('商业结构 JSON 不合法：episodes 存在非正整数 ep')
      }
      if (eps.has(ep['ep'])) throw new Error(`商业结构 JSON 不合法：第 ${ep['ep']} 集重复`)
      eps.add(ep['ep'])
      if (typeof ep['ending_cliffhanger'] !== 'string' || !ep['ending_cliffhanger'].trim()) {
        throw new Error(`商业结构 JSON 不合法：第 ${String(ep['ep'])} 集缺 ending_cliffhanger（集末悬念是卡点结构的最小承载）`)
      }
      for (const key of ['opening_hook', 'paywall_note']) {
        const v = ep[key]
        if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
          throw new Error(`商业结构 JSON 不合法：第 ${String(ep['ep'])} 集的 ${key} 若提供需为非空字符串`)
        }
      }
      if (ep['paywall_candidate'] !== undefined && typeof ep['paywall_candidate'] !== 'boolean') {
        throw new Error(`商业结构 JSON 不合法：第 ${String(ep['ep'])} 集的 paywall_candidate 需为布尔`)
      }
    }
    // 连续覆盖 1..N（集号链不断档，下游按 ep 对齐分集地图）
    if (eps.size !== epsArr.length || [...eps].some((n) => n > epsArr.length)) {
      throw new Error('商业结构 JSON 不合法：ep 需连续覆盖 1..集数（缺集或越界）')
    }
    return epsArr.length
  }
  return 0
}

/** LLM 偶尔输出 markdown 围栏：剥除后取首个 {...} */
function extractJson(raw: string): string {
  const noFence = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const start = noFence.indexOf('{')
  if (start < 0) throw new Error('LLM 返回中无 JSON 对象')
  return noFence.slice(start)
}
