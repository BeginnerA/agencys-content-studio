/**
 * M60 探针（短剧商业化结构设计：付费卡点/开场钩子/留人节奏——剧情设计思路层，非真实付费门禁）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m60.ts [--section=contract|template|inject|drift]
 *
 * 隔离策略：纯函数 + 契约 + 静态文件面（validateTextOutput/storage 登记/模板结构/提示词真源），
 *   isolatedEnv('m60', bridge templates+prompts) 即可，零 DB、零网络、零模型调用。
 *
 * 断言聚焦 M60 收口契约：
 *   - contract：monetization-json 登记进 JSON_FORMATS（mime/ext 归 json）；validateTextOutput 合法/越界
 *     （缺 ending_cliffhanger、ep 断链、episode_count 不符、paywall_candidate 非布尔）拒绝；
 *   - template：series-setup v4/13 步 + monetize 步接线 + with_monetization 默认开；
 *     mengbao-episode v15 setting_docs accept 含 .json（商业结构可被单集 run 选入承接链）；
 *   - inject：monetize-structure.md 契约段齐全且显式「付费由发布平台决定」措辞；script-ep R19 /
 *     storyboard-ep 规则12 / creation-plan 开场纪律 / series-setup.md 下游衔接四条注入线在位；
 *   - drift：purpose=monetization 归档 texts（0 新表 0 新目录）；with_monetization=false 时
 *     write_series 步结构与闸文案不变（关闭态回退 v3 行为）；提示词已入出厂清单。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL。断言文案内不嵌 PASS/FAIL 词元（保 parseProbeOutput 精确）。
 */
import { isolatedEnv, makeChecker, runSections, type Checker } from './probe-lib'

const { cleanup: envCleanup } = isolatedEnv('m60', { bridge: ['templates', 'prompts'] })

const SECTIONS = ['contract', 'template', 'inject', 'drift'] as const

/** 合法商业结构样例（4 集迷你季：第 3 集卡点） */
function goodDoc(override?: (doc: Record<string, unknown>) => void) {
  const doc: Record<string, unknown> = {
    title: '探针剧',
    episode_count: 4,
    free_episode_range: [1, 2],
    positioning_rationale: '前两集立冲突试水，第 3 集风暴开闸收最强悬念。',
    episodes: [
      { ep: 1, opening_hook: '画面一', ending_cliffhanger: '红帖送到门口', paywall_candidate: false, rhythm_note: '立危机' },
      { ep: 2, opening_hook: '画面二', ending_cliffhanger: '当众反转', paywall_candidate: false, rhythm_note: '首次反击' },
      { ep: 3, opening_hook: '画面三', ending_cliffhanger: '身份将揭未揭', paywall_candidate: true, paywall_note: '全季最强悬念落点', rhythm_note: '风暴开闸' },
      { ep: 4, opening_hook: '画面四', ending_cliffhanger: '决战余韵', paywall_candidate: false, rhythm_note: '收束' },
    ],
  }
  if (override) override(doc)
  return doc
}

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m60')
  const checker: Checker = makeChecker(log)
  const check = checker.check

  const SECTIONS_RUNNERS: Record<string, () => Promise<void>> = {
    // ================= contract：monetization-json 契约校验 =================
    contract: async () => {
      const { validateTextOutput } = await import('../src/pipeline/actions/ai-text')
      const { JSON_FORMATS, isJsonTextFormat, purposeSubDir } = await import('../src/services/storage')
      check((JSON_FORMATS as readonly string[]).includes('monetization-json'), 'JSON_FORMATS 已登记 monetization-json')
      check(isJsonTextFormat('monetization-json') === true, 'isJsonTextFormat → mime/ext 走 application/json/.json')
      check(validateTextOutput(JSON.stringify(goodDoc()), 'monetization-json') === 4, '合法四集结构 → 通过且返回集数 4')
      const noCliff = goodDoc((d) => { const eps = d.episodes as Record<string, unknown>[]; delete eps[1]!.ending_cliffhanger })
      let threw = ''
      try { validateTextOutput(JSON.stringify(noCliff), 'monetization-json') } catch (e) { threw = (e as Error).message }
      check(threw.includes('ending_cliffhanger'), '缺集末悬念 → 拒绝（卡点结构最小承载）')
      const brokenChain = goodDoc((d) => {
        const eps = d.episodes as Array<Record<string, unknown>>
        eps.splice(1, 1) // 删第 2 集 → ep 序列变 [1,3,4]：越界且缺集，应被「连续覆盖」拒
        d.episode_count = 3
      })
      let threw2 = ''
      try { validateTextOutput(JSON.stringify(brokenChain), 'monetization-json') } catch (e) { threw2 = (e as Error).message }
      check(threw2.includes('连续覆盖'), 'ep 断链（1,3,4 缺第 2 集）→ 拒绝')
      const countMismatch = goodDoc((d) => { d.episode_count = 5 })
      let threw3 = ''
      try { validateTextOutput(JSON.stringify(countMismatch), 'monetization-json') } catch (e) { threw3 = (e as Error).message }
      check(threw3.includes('episode_count'), 'episode_count 与集数不符 → 拒绝')
      const badFlag = goodDoc((d) => {
        const target = (d.episodes as Array<Record<string, unknown>>)[2] as unknown as Record<string, unknown>
        target.paywall_candidate = 'yes'
      })
      let threw4 = ''
      try { validateTextOutput(JSON.stringify(badFlag), 'monetization-json') } catch (e) { threw4 = (e as Error).message }
      check(threw4.includes('paywall_candidate'), 'paywall_candidate 非布尔 → 拒绝')
      check(purposeSubDir('monetization') === 'texts', 'purpose=monetization 归档 texts（0 新表 0 新目录）')
    },

    // ================= template：series-setup v4 + mengbao-episode v15 承接面 =================
    template: async () => {
      const { loadTemplate } = await import('../src/pipeline/loader')
      const se = loadTemplate('series-setup')
      check(se.version === 4 && se.steps.length === 13, `series-setup v4/13 步（实际 ${se.version}/${se.steps.length}）`)
      const mz = se.steps.find((s) => s.key === 'monetize')
      check(!!mz && mz.action === 'ai_text' && mz.params?.['output_format'] === 'monetization-json', 'monetize 步存在且挂 monetization-json 契约')
      check(!!mz && (mz.after ?? []).includes('write_series') && mz.inputs?.['series'] === 'steps.write_series.asset', 'monetize 吃 write_series 设定包（唯一上游）')
      const wm = se.inputs.find((i) => i.key === 'with_monetization')
      check(!!wm && wm.default === true, 'with_monetization 默认开（立项默认产商业结构）')
      const ep = loadTemplate('mengbao-episode')
      check(ep.version === 15, `mengbao-episode v15（实际 ${ep.version}）`)
      const sd = ep.inputs.find((i) => i.key === 'setting_docs')
      check(!!sd && (sd.accept ?? []).includes('.json'), 'setting_docs accept 含 .json（商业结构 json 可被单集 run 选入注入链）')
      check(ep.steps.length === 21, `mengbao-episode 仍 21 步（实际 ${ep.steps.length}，v15 只放宽 accept 不动结构）`)
    },

    // ================= inject：四条提示词注入线在位 =================
    inject: async () => {
      const { loadPromptTemplate } = await import('../src/services/llm')
      const mon = loadPromptTemplate('monetize-structure.md')
      check(mon.includes('monetization-json') && mon.includes('ending_cliffhanger'), 'monetize-structure.md：契约名与必填字段在位')
      check(mon.includes('发布平台决定'), 'monetize-structure.md：显式「真实付费由发布平台决定」定位纪律')
      check(mon.includes('paywall_candidate') && mon.includes('free_episode_range'), 'monetize-structure.md：卡点标记与建议免费区间字段在位')
      const script = loadPromptTemplate('script-ep.md')
      check(script.includes('R19') && script.includes('商业结构设计.json'), 'script-ep：R19 商业结构承接规则在位')
      check(script.includes('paywall_candidate'), 'script-ep：卡点集「禁止解悬念收笔」细则在位')
      const board = loadPromptTemplate('storyboard-ep.md')
      check(board.includes('商业结构落镜') && board.includes('opening_hook'), 'storyboard-ep：规则12 商业结构落镜在位')
      const plan = loadPromptTemplate('creation-plan.md')
      check(plan.includes('开场纪律') && plan.includes('前 3 秒'), 'creation-plan：前 3 秒开场钩子纪律在位')
      const se = loadPromptTemplate('series-setup.md')
      check(se.includes('商业结构设计') && se.includes('ending_cliffhanger'), 'series-setup.md：下游衔接行（分集地图→ending_cliffhanger 事实源）在位')
      const { BUILTIN_PROMPT_NAMES } = await import('../src/pipeline/builtin-assets')
      check(BUILTIN_PROMPT_NAMES.has('monetize-structure.md'), 'monetize-structure.md 已入出厂提示词清单')
    },

    // ================= drift：关闭态回退 + 注入链结构不变 =================
    drift: async () => {
      const { loadTemplate } = await import('../src/pipeline/loader')
      const se = loadTemplate('series-setup')
      const keys = se.steps.map((s) => s.key)
      const ws = se.steps.find((s) => s.key === 'write_series')
      check(keys[3] === 'monetize' && keys[4] === 'char_profile', 'monetize 插在 write_series 与 char_profile 之间（链序确定）')
      check(ws?.action === 'ai_text' && ws?.gate?.mode === 'required' && !!ws.gate.skip_label === false, 'write_series 必审闸原样（v3 语义不动）')
      check((ws?.params?.['prompt_tpl']) === 'series-setup.md', 'write_series 提示词真源未换')
      const ep = loadTemplate('mengbao-episode')
      const ms = ep.steps.find((s) => s.key === 'make_storyboard')
      check(ms?.inputs?.['setting'] === 'steps.ingest_docs.assets', 'make_storyboard 仍经 ingest_docs 吃设定资料（json 注入走既有链，0 新接线）')
      const ws2 = ep.steps.find((s) => s.key === 'write_script')
      check(ws2?.inputs?.['setting'] === 'steps.ingest_docs.assets', 'write_script 同上（剧本步零新键）')
      check(ep.inputs.some((i) => i.key === 'prev_script'), 'prev_script 承接输入未动（v12 语义与 M60 注入互不干扰）')
      const { purposeSubDir } = await import('../src/services/storage')
      check(purposeSubDir('monetization') === purposeSubDir('plan'), '与分集规划同归档（无专属新表/新目录=0 体裁专属结构承诺）')
    },
  }

  await runSections({ log, title: 'M60', checker, sections: SECTIONS, runners: SECTIONS_RUNNERS, cleanup: envCleanup })
}

void main()
