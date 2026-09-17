/**
 * M25 探针（输入源扩展：小说链 G1–G8 + 视频 G9/G10）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m25.ts [--section=docparse|content-write|graph-layout|audit|merge|append|fetch|analyze]
 *
 * 隔离策略：CSTUDIO_ROOT / CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录
 * （独立 studio.db + workspace），不触碰开发库（同 probe-m3~m24）。零网络、零计费：
 * 直测服务层纯函数与注册面，不触发引擎执行、真实生成与 LLM/ASR 调用（网络面走 e2e 实弹）。
 *
 * section（默认 all；P0 冒烟骨架，逐批填充全矩阵，spec §7）：
 *   docparse      [P1] docFormatByExt / findOpfPath / parseEpubSpine（P0 已直测）+ epubToText/parseDocBuffer 端到端（P1 补）
 *   content-write [P2] 白名单常量 / ContentEditError（P0 已直测）+ 原子覆写落库往返（P1 补）
 *   graph-layout  [P2] nodeRadius / computeGraphLayout 确定性矩阵（P0 已直测）
 *   audit         [P2] parseAuditVerdict 契约矩阵（P0 已直测）+ action 接线（P2 补）
 *   merge         [P2] per_source 逐 source 切分（已填：mock ctx 端到端 textSplit + 回归锚）
 *   append        [P2] 幂等去重 / 续编（已填：真实 run/step/manifest 基座 + 重放/混合/守卫矩阵）
 *   fetch         [P3] assertSafeUrl SSRF 矩阵 / extractReadableText / decodeEntities（P0 已直测）+ 网络抓取（P3 e2e）
 *   analyze       [P3] parseTimelineJson / 帧数常量（P0 已直测）+ ffprobe/ASR/多模态接线（P3 补）
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
const TMP_PREFIX = 'acs-probe-m25-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch {
      /* 占用中（并行探针）→ 跳过 */
    }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })
// 模板/提示词桥接：junction（零拷贝）指向真实 workspace（探针只读不写）
const bridgeReadOnly = (sub: 'templates' | 'prompts'): void => {
  const real = join(REPO_ROOT, 'workspace', sub)
  const tmp = join(process.env.CSTUDIO_WORKSPACE!, sub)
  if (existsSync(tmp) || !existsSync(real)) return
  try {
    symlinkSync(real, tmp, 'junction')
  } catch {
    cpSync(real, tmp, { recursive: true })
  }
}
bridgeReadOnly('templates')
bridgeReadOnly('prompts')

const SECTIONS = ['docparse', 'content-write', 'graph-layout', 'audit', 'merge', 'append', 'fetch', 'analyze'] as const

const canon = (v: unknown): string => JSON.stringify(v)

async function main(): Promise<void> {
  const { createLogger } = await import('../src/logger')
  const log = createLogger('probe-m25')
  let failed = 0
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }
  const skip = (msg: string): void => log.info(`  SKIP  ${msg}`)

  // ---- 隔离库懒初始化（多节共用；首用节自建一次性 project） ----
  type ProbeDb = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any
    pid: number
  }
  let probeDb: ProbeDb | null = null
  const ensureProject = async (): Promise<ProbeDb> => {
    if (probeDb) return probeDb
    const { db, initDb } = await import('../src/db')
    await initDb()
    const { projects } = await import('../src/db/schema')
    const T0 = 1_700_000_000_000
    const [proj] = await db
      .insert(projects)
      .values({ name: 'M25 探针', genre: 'other', templateKey: 'x', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
      .returning()
    probeDb = { db, pid: proj!.id }
    return probeDb
  }

  // ---- 合成 epub（zipSync；探针与 importFiles 转换断言共用样本） ----
  const buildEpubBytes = async (): Promise<Uint8Array> => {
    const { zipSync, strToU8 } = await import('fflate')
    const NL = String.fromCharCode(10)
    const ch1 = `<html><body><h1>第一章 初遇</h1>${NL}<p>${'这是第一章的正文内容，'.repeat(20)}</p></body></html>`
    const ch2 = `<html><body><h1>第二章 离别</h1>${NL}<p>${'这是第二章的正文内容，'.repeat(20)}</p></body></html>`
    return zipSync({
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
      'OEBPS/content.opf': strToU8(['<package xmlns="http://www.idpf.org/2007/opf"><manifest>', '<item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>', '<item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>', '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'].join(NL)),
      // ⚠ fflate 第二参 true = latin1（非 UTF-8！实测 0.8.3）；中文样本一律无参形态（缺省即 UTF-8，与 doc-parse 读取侧对称）
      'OEBPS/Text/ch1.xhtml': strToU8(ch1),
      'OEBPS/Text/ch2.xhtml': strToU8(ch2),
    })
  }

  // ---- 注册面（各节共用） ----
  const { KNOWN_ACTIONS } = await import('../src/pipeline/loader')
  const { listActionKeys } = await import('../src/pipeline/actions')

  // ================= docparse：G1 文档解析纯函数 =================
  const sectionDocparse = async (): Promise<void> => {
    const { docFormatByExt, findOpfPath, parseEpubSpine, epubToText, parseDocBuffer, DocParseError } = await import('../src/services/doc-parse')
    check(docFormatByExt('Book.DOCX') === 'docx', 'docFormatByExt .DOCX 大小写不敏感 → docx')
    check(docFormatByExt('novel.epub') === 'epub', 'docFormatByExt .epub → epub')
    check(docFormatByExt('notes.txt') === null, 'docFormatByExt .txt → null（走原链不解析）')
    // container.xml → OPF 路径
    const files: Record<string, Uint8Array> = {
      'META-INF/container.xml': new TextEncoder().encode('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
      'OEBPS/content.opf': new TextEncoder().encode('<package></package>'),
    }
    check(findOpfPath(files) === 'OEBPS/content.opf', 'findOpfPath 解析 full-path')
    let cerr = false
    try {
      findOpfPath({ 'readme.txt': new Uint8Array() })
    } catch (e) {
      cerr = e instanceof DocParseError && (e as { code?: string }).code === 'no_container'
    }
    check(cerr, '缺 container.xml → DocParseError(no_container)')
    // spine：manifest id→href × spine idref 顺序；跳过图片 media-type；相对路径归一
    const opf = [
      '<package xmlns="http://www.idpf.org/2007/opf"><manifest>',
      '<item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml" title="第一章"/>',
      '<item id="img" href="Images/cover.jpg" media-type="image/jpeg"/>',
      '<item id="c2" href="Text/../Text/ch2.xhtml" media-type="application/xhtml+xml" title="第二章"/>',
      '</manifest><spine page-progression-direction="ltr"><itemref idref="c1"/><itemref idref="img"/><itemref idref="c2"/></spine></package>',
    ].join('')
    const spine = parseEpubSpine(opf, 'OEBPS/content.opf')
    check(spine.length === 2, `spine 过滤图片项剩 2（实得 ${spine.length}）`)
    check(spine[0]!.path === 'OEBPS/Text/ch1.xhtml' && spine[1]!.path === 'OEBPS/Text/ch2.xhtml', '相对/../路径归一正确')
    check(spine[0]!.title === '第一章', 'manifest title 提取')
    let serr = false
    try {
      parseEpubSpine('<package><manifest></manifest><spine></spine></package>', 'x.opf')
    } catch (e) {
      serr = e instanceof DocParseError && (e as { code?: string }).code === 'empty_spine'
    }
    check(serr, '空 spine → DocParseError(empty_spine)')
    // ---- [P1] 端到端：zipSync 合成 epub → epubToText / parseDocBuffer ----
    const epubBytes = await buildEpubBytes()
    const text = epubToText(epubBytes)
    check(text.includes('第一章 初遇') && text.includes('第二章 离别'), 'epubToText 提取 h1 章题行（纯文本无 # 前缀，保 ^第X章 行首正则）')
    check(/^第一章 初遇/um.test(text), '章题位于行首（unbound ^ 命中）——text_split 默认可识别')
    check(!text.includes('<html') && !text.includes('<?xml'), 'XHTML 标签已剥离')
    const parsed = await parseDocBuffer('demo.epub', epubBytes)
    check(parsed.format === 'epub' && parsed.text === text, 'parseDocBuffer .epub → format=epub 且文本一致')
    let zerr = false
    try {
      epubToText(new TextEncoder().encode('not a zip at all'))
    } catch (e) {
      zerr = e instanceof DocParseError && (e as { code?: string }).code === 'bad_zip'
    }
    check(zerr, '非 zip 字节 → DocParseError(bad_zip)（DRM/损坏同路径）')
    let ferr = false
    try {
      await parseDocBuffer('notes.txt', new TextEncoder().encode('hi'))
    } catch (e) {
      ferr = e instanceof DocParseError && (e as { code?: string }).code === 'bad_format'
    }
    check(ferr, '非 docx/epub 入口调用 → DocParseError(bad_format)')
  }

  // ================= content-write：G2 内容覆写常量与错误契约（落库往返 P1 补） =================
  const sectionContentWrite = async (): Promise<void> => {
    const { EDITABLE_PURPOSES, MAX_CONTENT_CHARS, ContentEditError } = await import('../src/services/asset-content')
    for (const p of ['source', 'chapters', 'events', 'graph', 'plan', 'script', 'text', 'export', 'video_analysis']) {
      check((EDITABLE_PURPOSES as readonly string[]).includes(p), `白名单含 purpose=${p}`)
    }
    check(!(EDITABLE_PURPOSES as readonly string[]).includes('compliance_report'), '白名单不含 compliance_report（非编辑目标）')
    check(MAX_CONTENT_CHARS === 2_000_000, '内容上限 2,000,000 字符')
    const e = new ContentEditError('bad_kind', 'x')
    check(e instanceof Error && e.code === 'bad_kind', 'ContentEditError 携带 code 供路由映射 4xx')

    // ---- [P1] 落库往返（隔离库）：importFiles 转换 + 覆写原子性/留痕 + 守卫矩阵 ----
    const { db, pid } = await ensureProject()
    const { assets: assetsTbl } = await import('../src/db/schema')
    const { eq: deq } = await import('drizzle-orm')
    const { readFileSync } = await import('node:fs')
    const { importFiles, writeTextAsset, absPathOf } = await import('../src/services/storage')
    const { updateAssetContent } = await import('../src/services/asset-content')
    // G1 入库单点：epub → md 文本资产（原二进制不落盘）
    const epubBytes = await buildEpubBytes()
    const imported = await importFiles(pid, [{ name: '测试书.epub', data: epubBytes }], { purpose: 'source' })
    const imp = imported[0]!
    check(imp.kind === 'text' && imp.name === '测试书.md' && imp.ext === 'md', `importFiles epub → md 文本资产（kind=${imp.kind} name=${imp.name}）`)
    check(JSON.parse(imp.params ?? '{}').doc_import?.format === 'epub', 'params.doc_import.format=epub 留痕')
    check(readFileSync(absPathOf(imp.relPath!), 'utf8').includes('第一章 初遇'), '落盘内容 = 解析后纯文本')
    const again = await importFiles(pid, [{ name: '测试书副本.epub', data: await buildEpubBytes() }], { purpose: 'source' })
    check(again[0]!.id === imp.id, '同内容异文件名 → sha256 去重命中转换后资产（幂等）')
    // 覆写往返：同 relPath 原子覆盖 + sha256/size 更新 + content_edits 累加
    const edited = await updateAssetContent(imp.id, '第一章 初遇\n改过的正文。')
    check(edited.sha256 !== imp.sha256 && edited.relPath === imp.relPath && edited.fileSize === new TextEncoder().encode('第一章 初遇\n改过的正文。').byteLength, '覆写：同 relPath + sha256/size 更新')
    check(readFileSync(absPathOf(edited.relPath!), 'utf8') === '第一章 初遇\n改过的正文。', '物理文件内容 = 新文本')
    check(JSON.parse(edited.params ?? '{}').content_edits?.count === 1, 'params.content_edits.count=1（首次编辑留痕）')
    const edited2 = await updateAssetContent(imp.id, '再改一次')
    check(JSON.parse(edited2.params ?? '{}').content_edits?.count === 2, '二次编辑 count 累加至 2')
    check((await db.select().from(assetsTbl).where(deq(assetsTbl.id, imp.id)))[0]!.name.endsWith('.md'), '行 name 已为 .md（后续链读文本路径零感知）')
    // 守卫矩阵：自登资产不碰内容 + 非白名单 purpose 拒 + JSON 契约拒 + 空内容拒
    const mem = await writeTextAsset(pid, { name: 'mem.json', content: '{}', purpose: 'memory', format: 'lines-json' })
    let g1 = ''
    try {
      await updateAssetContent(mem.id, 'x')
    } catch (err) {
      g1 = err instanceof ContentEditError ? err.code : 'other'
    }
    check(g1 === 'bad_purpose', 'purpose=memory 不在白名单 → bad_purpose（记忆不自毁）')
    const chap = await writeTextAsset(pid, { name: 'events.json', content: JSON.stringify({ events: [{ name: 'e', chapters: [1] }] }), purpose: 'events', format: 'event-json', params: { output_format: 'event-json' } })
    let g2 = ''
    try {
      await updateAssetContent(chap.id, '{"events": "坏结构"}')
    } catch (err) {
      g2 = err instanceof ContentEditError ? err.code : 'other'
    }
    check(g2 === 'bad_json', 'JSON 资产坏结构保存 → bad_json 拒写（契约拦截）')
    const before = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, chap.id)))[0]!
    check(readFileSync(absPathOf(before.relPath!), 'utf8').includes('坏结构') === false, '拒写后物理文件零变化（守卫先于落盘）')
    let g3 = ''
    try {
      await updateAssetContent(imp.id, '   ')
    } catch (err) {
      g3 = err instanceof ContentEditError ? err.code : 'other'
    }
    check(g3 === 'empty_content', '空/空白内容 → empty_content')
  }

  // ================= graph-layout：G3 确定性力导向布局 =================
  const sectionGraphLayout = async (): Promise<void> => {
    const { computeGraphLayout, nodeRadius, GRAPH_TICKS, deriveGraphNodesLinks, layoutFromGraphDoc } = await import('../src/services/graph-layout')
    check(nodeRadius({ id: 'e1', kind: 'event', label: 'A', weight: 5 }, 0) === 27, '事件半径 22+min(10,weight=5)=27')
    check(nodeRadius({ id: 'c1', kind: 'character', label: 'X' }, 3) === 17, '角色半径 14+min(8,degree=3)=17')
    check(nodeRadius({ id: 'c1', kind: 'character', label: 'X' }, 20) === 22, '角色半径封顶 14+8=22')
    const empty = computeGraphLayout([], [])
    check(canon(empty) === canon({ nodes: [], links: [], width: 0, height: 0 }), '空图 → 全零')
    const single = computeGraphLayout([{ id: 'e1', kind: 'event', label: 'A' }], [])
    check(single.nodes.length === 1 && single.nodes[0]!.x === 120 && single.nodes[0]!.y === 100, '单节点固定 (120,100) 不迭代')
    const nodes = [
      { id: 'e1', kind: 'event' as const, label: '起因', weight: 3 },
      { id: 'e2', kind: 'event' as const, label: '经过' },
      { id: 'c1', kind: 'character' as const, label: '甲' },
    ]
    const links = [
      { source: 'e1', target: 'c1', kind: 'member' as const },
      { source: 'e1', target: 'e2', kind: 'sequence' as const },
      { source: 'e2', target: 'ghost', kind: 'member' as const }, // 悬空 → 过滤
      { source: 'e1', target: 'e1', kind: 'member' as const }, // 自环 → 过滤
    ]
    const L1 = computeGraphLayout(nodes, links)
    const L2 = computeGraphLayout(nodes, links)
    check(canon(L1) === canon(L2), '同输入两次布局完全一致（确定性，无随机源）')
    check(L1.links.length === 2, `自环+悬空过滤后剩 2 条边（实得 ${L1.links.length}）`)
    check(L1.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), '所有输出坐标有限（NaN 兜底生效）')
    // 包围盒不变量：含半径的左/上边缘平移至 40（minX=min(x-r)），round 后允许 ±1 误差；节点中心必 ≥ 40
    const minEdgeX = Math.min(...L1.nodes.map((n) => n.x - n.r))
    const minEdgeY = Math.min(...L1.nodes.map((n) => n.y - n.r))
    check(L1.nodes.every((n) => n.x >= 40 && n.y >= 40) && Math.abs(minEdgeX - 40) <= 1 && Math.abs(minEdgeY - 40) <= 1, `含半径包围盒左上平移至 (40,40)（edgeX=${minEdgeX} edgeY=${minEdgeY}）`)
    check(L1.width > 0 && L1.height > 0 && GRAPH_TICKS === 300, '画布尺寸正数 + tick 常量 300')

    // ---- [P2·G3] graph-json 文档 → 节点/边推导（纯函数）----
    const doc = {
      overview: '梗概',
      characters: [{ name: '甲', role: '主' }, { name: '乙', role: '次' }, { name: '甲' }], // 甲重名去重
      key_events: [
        { id: 'E1', name: '相遇', summary: '甲和乙相遇', chapters: [2, 5], intensity: 3, kind: 'plot' },
        { id: 'E2', name: '离别', summary: '乙离去', chapters: [1, 3], intensity: 2, kind: 'plot' },
        { id: 'E3', name: '重逢', summary: '甲乙再会', chapters: [8], intensity: 1, kind: 'plot' },
      ],
    }
    const derived = deriveGraphNodesLinks(doc)
    check(!!derived && derived.nodes.length === 5, `节点=3事件+2角色（甲重名去重）（实得 ${derived?.nodes.length}）`)
    const seq = derived!.links.filter((l) => l.kind === 'sequence')
    check(seq.length === 2 && seq[0]!.source === 'event:离别' && seq[0]!.target === 'event:相遇', 'sequence 边按 min(chapter) 升序相邻连（离别[1]→相遇[2]）')
    check(derived!.links.filter((l) => l.kind === 'member').length === 5, 'member 角色名子串命中事件文本 5 条（E1×2 E2×1 E3×2）')
    const evNode = derived!.nodes.find((n) => n.id === 'event:相遇')
    check(evNode?.weight === 2 && evNode?.kind === 'event', '事件节点 weight=覆盖章数=2')
    check(deriveGraphNodesLinks(null) === null && deriveGraphNodesLinks([]) === null, 'null/数组 doc → null（脏数据宽容）')
    check(deriveGraphNodesLinks({ characters: [{ name: '甲' }] }) === null, '无 key_events → null')
    check(layoutFromGraphDoc({ key_events: [] }) === null, '空事件 layoutFromGraphDoc → null（前端降级表视图）')
    const L3 = layoutFromGraphDoc(doc)
    check(!!L3 && canon(L3) === canon(layoutFromGraphDoc(doc)), 'layoutFromGraphDoc 同输入两次完全一致（确定性）')
    check(L3!.nodes.length === 5, 'SVG 节点数 = 事件+角色（spec §4.3 前端断言锚）')
  }

  // ================= audit：G4 回查契约解析 =================
  const sectionAudit = async (): Promise<void> => {
    const { parseAuditVerdict } = await import('../src/pipeline/actions/adapt-audit')
    check(parseAuditVerdict('```json\n{"faithful":false,"divergences":[{"kind":"omission","severity":"major","desc":"缺少关键转折","ref":"第3章"}]}\n```')?.faithful === false, 'markdown 围栏 + major → faithful=false')
    const clean = parseAuditVerdict('{"faithful":true,"divergences":[]}')
    check(clean?.faithful === true && clean.divergences.length === 0, '干净判定解析')
    const inferred = parseAuditVerdict('{"divergences":[{"kind":"addition","severity":"warn","desc":"新增支线","ref":"ep2"}]}')
    check(inferred?.faithful === true, 'faithful 缺省：无 major → 推断 true')
    const badSeverity = parseAuditVerdict('{"divergences":[{"kind":"omission","severity":"critical","desc":"x","ref":"y"}]}')
    check(badSeverity?.divergences.length === 0, '非法 severity 条目丢弃')
    check(parseAuditVerdict('not json at all') === null, '非 JSON → null（宽容降级）')
    check(parseAuditVerdict('{"faithful":"yes","divergences":"nope"}')?.faithful === true, 'faithful 非布尔 + divergences 非数组 → 宽容缺省 true')
  }

  // ---- text_split mock StepContext（merge/append 节共用：只喂 source 通道）----
  const mkSplitCtx = async (
    params: Record<string, unknown>,
    srcIds: number[],
    runStep?: { runId: number; stepId: number },
  ) => {
    const { db, pid } = await ensureProject()
    const { assets: assetsTbl } = await import('../src/db/schema')
    const { inArray } = await import('drizzle-orm')
    const { readTextAsset } = await import('../src/services/storage')
    return {
      def: { params },
      input: {},
      log: () => {},
      run: { id: runStep?.runId ?? 0, projectId: pid },
      step: { id: runStep?.stepId ?? 0 },
      assetIdsOf: (k: string) => (k === 'source' ? srcIds : []),
      assetsOf: async (ids: number[]) => await db.select().from(assetsTbl).where(inArray(assetsTbl.id, ids)),
      readText: async (id: number) => await readTextAsset(id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as any
  }

  // ================= merge：G6 逐 source 切分（per_source） =================
  const sectionMerge = async (): Promise<void> => {
    const { db, pid } = await ensureProject()
    const { textSplit, splitChapters } = await import('../src/pipeline/actions/text-split')
    const { writeTextAsset, readTextAsset } = await import('../src/services/storage')
    const { assets: assetsTbl } = await import('../src/db/schema')
    const { eq: deq } = await import('drizzle-orm')
    const NL = String.fromCharCode(10)
    const mkBook = (tag: string): string =>
      ['一', '二', '三']
        .map((cn, i) => `第${cn}章 ${tag}${i + 1}${NL}${tag}书正文，${'充实内容'.repeat(25)}。`)
        .join(NL + NL)
    const t1 = mkBook('甲')
    const t2 = mkBook('乙')
    const b1 = await writeTextAsset(pid, { name: '书一.md', content: t1, purpose: 'source' })
    const b2 = await writeTextAsset(pid, { name: '书二.md', content: t2, purpose: 'source' })

    // —— per_source=true：两书各 3 章逐源独立切 + 跨书续编 ——
    const sp = await textSplit(await mkSplitCtx({ min_chapters: 1, per_source: true }, [b1.id, b2.id]))
    check(sp.assetIds.length === 7, `per_source：manifest + 6 章资产（实得 ${sp.assetIds.length} 产物）`)
    type ManPS = { per_source?: boolean; books?: Array<{ name: string; count: number }>; chapters: Array<{ index: number; title: string; asset_id: number; source_book?: string }> }
    const manPS = JSON.parse(await readTextAsset(sp.assetIds[0]!)) as ManPS
    check(manPS.per_source === true && manPS.books?.length === 2, 'manifest.per_source=true + books[] 两书摘要')
    check(manPS.books![0]!.name === '书一.md' && (manPS.books ?? []).every((b) => b.count === 3), `books name/count（实得 ${JSON.stringify(manPS.books)}）`)
    check(canon((manPS.chapters ?? []).map((c) => c.index)) === canon([1, 2, 3, 4, 5, 6]), 'index 跨书续编 1..6（书二章号重启但不续编）')
    check(manPS.chapters.every((c, i) => c.source_book === (i < 3 ? '书一.md' : '书二.md')), 'manifest 逐章 source_book 归属')
    const ch4Row = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, manPS.chapters[3]!.asset_id)))[0]!
    const ch4p = JSON.parse(ch4Row.params ?? '{}') as Record<string, unknown>
    check(ch4p.index === 4 && ch4p.source_book === '书二.md', '逐章资产 params 继承续编 index + source_book')
    // 与纯函数逐源组合等价（offset 循环口径）
    const manual: string[] = []
    let off = 0
    for (const t of [await readTextAsset(b1.id), await readTextAsset(b2.id)]) {
      for (const c of splitChapters(t, null).chapters) manual.push(`${++off}:${c.title}`)
    }
    check(canon(manPS.chapters.map((c) => `${c.index}:${c.title}`)) === canon(manual), 'per_source 循环与 splitChapters 逐源直组等价（纯函数组合）')

    // —— 回归锚：per_source=false 现行为逐字不变 ——
    const plain = await textSplit(await mkSplitCtx({ min_chapters: 1 }, [b1.id, b2.id]))
    const manPl = JSON.parse(await readTextAsset(plain.assetIds[0]!)) as Record<string, unknown> & { chapters: Array<{ index: number; title: string; chars: number; source_book?: string }> }
    check(!('per_source' in manPl) && !('books' in manPl), '默认路径 manifest 无 per_source/books 键')
    check(manPl.chapters.every((c) => !('source_book' in c)), '默认路径逐章条目无 source_book')
    const baseline = splitChapters(`${t1}\n\n${t2}`, null).chapters
    check(canon(manPl.chapters.map((c) => [c.index, c.title, c.chars])) === canon(baseline.map((c) => [c.index, c.title, c.content.length])), 'false 路径 = splitChapters(拼接全文) 逐字一致（回归锚）')
  }

  // ================= append：G7 增量连载 =================
  const sectionAppend = async (): Promise<void> => {
    const { db, pid } = await ensureProject()
    const { pipelineRuns, pipelineSteps, assets: assetsTbl } = await import('../src/db/schema')
    const { eq: deq } = await import('drizzle-orm')
    const { writeTextAsset, readTextAsset } = await import('../src/services/storage')
    const { textSplit } = await import('../src/pipeline/actions/text-split')
    const { appendNovelChapters, NovelAppendError } = await import('../src/services/novel-append')
    const T0 = 1_700_000_000_000
    const NL = String.fromCharCode(10)
    type Manifest = { total?: number; selected?: number; chapters: Array<{ index: number; title?: string; asset_id?: number; source_book?: string }>; appended_at?: Array<{ at: number; files: Array<{ file: string; added: number; skipped: number }> }> }
    const chap = (cn: string, title: string, body: string): string => `第${cn}章 ${title}${NL}${body}，${'充实正文'.repeat(25)}。`
    const readManifest = async (manifestId: number): Promise<Manifest> => JSON.parse(await readTextAsset(manifestId)) as Manifest

    // —— 构造真实 run + text_split 步骤（succeeded）+ 3 章 manifest ——
    const [run] = await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'novel-adapt', status: 'waiting_input', input: '{}', createdAt: T0, updatedAt: T0 }).returning()
    const [step] = await db.insert(pipelineSteps).values({ runId: run!.id, seq: 1, stepKey: 'split_chapters', actionKey: 'text_split', title: '章节切分', status: 'succeeded', createdAt: T0, updatedAt: T0 }).returning()
    const src = await writeTextAsset(pid, { name: '连载原文.md', purpose: 'source', content: [chap('一', '起风', '风从河谷吹上来'), chap('二', '山路', '两个人上了山'), chap('三', '灯火', '山下亮起了灯')].join(NL + NL) })
    const sp = await textSplit(await mkSplitCtx({ min_chapters: 1 }, [src.id], { runId: run!.id, stepId: step!.id }))
    await db.update(pipelineSteps).set({ output: JSON.stringify({ asset_ids: sp.assetIds }) }).where(deq(pipelineSteps.id, step!.id))
    const manifestId = sp.assetIds[0]!
    check((await readManifest(manifestId)).chapters.length === 3, 'append 基座：run/step/manifest 就位（3 章）')

    // —— 新增 2 章续编 4..5 ——
    const cont = [chap('四', '回访', '她又回到河谷'), chap('五', '远行', '终于动身远行')].join(NL + NL)
    const r1 = await appendNovelChapters(pid, run!.id, [{ name: '连载续.txt', data: new TextEncoder().encode(cont) }])
    check(r1.added === 2 && r1.skipped === 0 && r1.total === 5 && r1.new_asset_ids.length === 2, `append 2 章：added=2/skipped=0/total=5（实得 ${r1.added}/${r1.skipped}/${r1.total}）`)
    const m2 = await readManifest(manifestId)
    check(canon(m2.chapters.map((c) => c.index)) === canon([1, 2, 3, 4, 5]), 'manifest 章号续编 1..5')
    check(m2.total === 5 && m2.selected === 5, 'total/selected 同步 +2')
    check(m2.appended_at?.length === 1 && m2.appended_at[0]!.files[0]!.added === 2 && m2.appended_at[0]!.files[0]!.file === '连载续.txt', 'appended_at 记录批次（file/added）')
    const newAsset = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, r1.new_asset_ids[0]!)))[0]!
    const np = JSON.parse(newAsset.params ?? '{}') as Record<string, unknown>
    check(newAsset.purpose === 'chapters' && newAsset.runId === run!.id && newAsset.stepId === step!.id && np.index === 4 && typeof np.appended_at === 'number', '新章资产：同 step/run + index=4 续编 + appended_at 留痕')

    // —— 幂等重放：零写入 ——
    const r2 = await appendNovelChapters(pid, run!.id, [{ name: '连载续副本.txt', data: new TextEncoder().encode(cont) }])
    check(r2.added === 0 && r2.skipped === 2, '同内容重放 added=0/skipped=2（章粒度幂等）')
    const r2b = await appendNovelChapters(pid, run!.id, [{ name: '连载续空白.txt', data: new TextEncoder().encode(cont.replace(/，/g, ' ，').split(NL + NL).join(NL + ' ' + NL)) }])
    check(r2b.added === 0 && r2b.skipped === 2, '空白变体重放仍去重（键归一去全部空白）')
    check((await readManifest(manifestId)).appended_at?.length === 1, '无新章时 manifest 零重写（appended_at 仍 1 条）')

    // —— 混合输入：旧 1 + 新 1 ——
    const mixed = [chap('四', '回访', '她又回到河谷'), chap('六', '重逢', '多年后又见')].join(NL + NL)
    const r3 = await appendNovelChapters(pid, run!.id, [{ name: '混合.txt', data: new TextEncoder().encode(mixed) }])
    check(r3.added === 1 && r3.skipped === 1, '混合输入章粒度幂等：旧章拦截/新章入库')
    const m4 = await readManifest(manifestId)
    const ch6 = m4.chapters[5]!
    check(m4.chapters.length === 6 && ch6.index === 6 && ch6.source_book === '混合.txt', '第 6 章续编 + source_book 归属')

    // —— 红线：零触碰 run/step 状态机；manifest 重写走 G2 受控通道留痕 ——
    const runRow = (await db.select().from(pipelineRuns).where(deq(pipelineRuns.id, run!.id)))[0]!
    const stepRow = (await db.select().from(pipelineSteps).where(deq(pipelineSteps.id, step!.id)))[0]!
    check(runRow.status === 'waiting_input' && stepRow.status === 'succeeded', 'append 不改变 run/step 状态（不级联重跑）')
    const manRow = (await db.select().from(assetsTbl).where(deq(assetsTbl.id, manifestId)))[0]!
    const mp = JSON.parse(manRow.params ?? '{}') as { content_edits?: { count?: number } }
    check(mp.content_edits?.count === 2, `manifest 仅新章批次重写（content_edits=2，实得 ${mp.content_edits?.count}）`)

    // —— 守卫矩阵 ——
    const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e instanceof NovelAppendError ? e.code : 'other'
      }
    }
    check((await codeOf(() => appendNovelChapters(pid, 999_999, []))) === 'not_found', 'run 不存在 → not_found(404)')
    const [bareRun] = await db.insert(pipelineRuns).values({ projectId: pid, templateKey: 'novel-adapt', status: 'running', input: '{}', createdAt: T0, updatedAt: T0 }).returning()
    check((await codeOf(() => appendNovelChapters(pid, bareRun!.id, []))) === 'no_split', 'run 无切分步骤 → no_split(400)')
  }

  // ================= fetch：G8 SSRF 守卫 + 正文提取 =================
  const sectionFetch = async (): Promise<void> => {
    const { assertSafeUrl, extractReadableText } = await import('../src/services/fetch-source')
    const rejected = (u: string): string | null => {
      try {
        assertSafeUrl(u)
        return null
      } catch (e) {
        return (e as { code?: string }).code ?? 'err'
      }
    }
    check(rejected('http://example.com/a') === null, '公网 http → 放行')
    check(rejected('https://example.com') === null, '公网 https → 放行')
    check(rejected('ftp://example.com') === 'bad_protocol', 'ftp 协议 → bad_protocol')
    check(rejected('http://127.0.0.1/') === 'private_host', '回环 IPv4 → private_host')
    check(rejected('http://localhost:3000/') === 'private_host', 'localhost → private_host')
    check(rejected('http://192.168.1.1/') === 'private_host', 'RFC1918 → private_host')
    check(rejected('http://10.0.0.5/') === 'private_host', '10.x 私网 → private_host')
    check(rejected('http://100.64.0.1/') === 'private_host', 'CGNAT 100.64/10 → private_host')
    check(rejected('http://[::1]/') === 'private_host', 'IPv6 回环 ::1 → private_host')
    check(rejected('http://169.254.1.1/') === 'private_host', '链路本地 169.254 → private_host')
    check(rejected('http://example.internal/') === 'private_host', '.internal 域 → private_host')
    check(rejected('http://example.com:8080/') === 'bad_port', '非 80/443 端口 → bad_port')
    // 正文提取：噪声标签剥离 + 段落转换行 + 实体解码
    const html = '<html><head><script>var x=1</script><style>p{}</style></head><body><nav>menu</nav><article><h1>标题</h1><p>第一&amp;段 &#20013;&#25991;</p><p>第二段</p></article><footer>foot</footer></body></html>'
    const text = extractReadableText(html)
    check(!text.includes('var x=1') && !text.includes('menu') && !text.includes('foot'), 'script/nav/footer 剥离')
    check(text.includes('第一&段') && text.includes('中文'), '实体解码（命名 + 数字）')
    check(text.split('\n').filter(Boolean).length >= 2, '块级标签转换行（≥2 行）')
    check(extractReadableText('<div><p>' + 'x'.repeat(300) + '</p></div>').includes('x'), '无 article 回退全 body')
  }

  // ================= analyze：G9 时间轴契约 + 帧数常量 + [P3] 接线纯函数全矩阵 =================
  const sectionAnalyze = async (): Promise<void> => {
    const { parseTimelineJson, VIDEO_FRAME_COUNT_RANGE, clampFrameCount, uniformVideoTimes, buildAudioExtractArgs, renderAnalysisReportMd, ANALYSIS_FRAME_WIDTH } = await import('../src/pipeline/actions/video-analyze')
    check(VIDEO_FRAME_COUNT_RANGE.min === 2 && VIDEO_FRAME_COUNT_RANGE.max === 24 && VIDEO_FRAME_COUNT_RANGE.default === 8, '帧数独立常量 2–24 默认 8（不动画布 2–9）')
    const tl = parseTimelineJson('{"duration":10,"scenes":[{"t0":0,"t1":5,"visual":"A","shot_type":"近景"},{"t0":5,"t1":10,"visual":"B","speech":"你好"}],"transcript":[{"t0":0,"t1":4,"text":"你好"}]}')
    check(tl?.duration === 10 && tl?.scenes.length === 2 && tl.scenes[0]!.shot_type === '近景', '时间轴正常解析（含 shot_type/speech）')
    check(tl?.transcript?.[0]?.text === '你好', 'transcript 解析')
    const degenerate = parseTimelineJson('{"scenes":[{"t0":5,"t1":5,"visual":""},{"t0":0,"t1":3,"visual":"ok"}]}')
    check(degenerate?.scenes.length === 1 && degenerate.scenes[0]!.visual === 'ok', '退化 scene（空 visual 且区间退化）丢弃')
    check(parseTimelineJson('{"duration":5}') === null, '缺 scenes → null')
    check(parseTimelineJson('garbage') === null, '非 JSON → null（宽容降级）')
    check(parseTimelineJson('{"scenes":[{"t0":9,"t1":10,"visual":"late"},{"t0":1,"t2":2,"visual":"early"}]}')?.scenes[0]?.visual === 'early', 'scenes 按 t0 升序')

    // —— [P3] clampFrameCount 边界矩阵（spec §2.9 params.frames 2–24）——
    check(clampFrameCount(1) === 2 && clampFrameCount(100) === 24, 'clampFrameCount：1→2 / 100→24（越界 clamp）')
    check(clampFrameCount(undefined) === 8 && clampFrameCount('abc') === 8 && clampFrameCount(NaN) === 8, 'clampFrameCount：非法/缺失 → 默认 8')
    check(clampFrameCount(8.6) === 9, 'clampFrameCount：小数 round 8.6→9')

    // —— [P3] uniformVideoTimes：公式/边界/降级（spec §4.8 真实 24 帧边界锚）——
    const times24 = uniformVideoTimes(24, 120)
    check(times24.length === 24 && times24[0] === 0.1 && times24[23] === 119.9, `n=24/dur=120：首 0.1 尾 dur−0.1=119.9（实得 ${times24[0]}/${times24[23]}）`)
    check(times24.every((t, i) => i === 0 || t >= times24[i - 1]!), '24 帧时刻单调不降')
    check(canon(uniformVideoTimes(3, 10)) === canon([0.1, 5, 9.9]), `dur=10 n=3 中点精确 0.1+(dur−0.2)×0.5（实得 ${JSON.stringify(uniformVideoTimes(3, 10))}）`)
    const tiny = uniformVideoTimes(4, 0.2)
    check(tiny.length === 4 && tiny.every((t) => t === 0.1), 'dur≤0.3 全取首帧时刻 0.1（不抛错降级）')
    let utErr = false
    try {
      uniformVideoTimes(8, 0)
    } catch {
      utErr = true
    }
    check(utErr, 'dur 非法（0）→ 抛错（上层 StepError 接口）')
    check(uniformVideoTimes(100, 60).length === 24, 'count 越界先 clamp 再出时刻（n=100→24）')

    // —— [P3] 抽音轨 argv（ASR 通用入参形态固定）——
    check(
      canon(buildAudioExtractArgs('src.mp4', 'out.mp3')) === canon(['-y', '-hide_banner', '-loglevel', 'error', '-i', 'src.mp4', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', 'out.mp3']),
      'buildAudioExtractArgs：16k 单声道 mp3 argv 逐字定形',
    )

    // —— [P3] 人读报告渲染（时间轴表 + 转写段 + 降级文案）——
    const report = renderAnalysisReportMd({ duration: 10, scenes: [{ t0: 0, t1: 5, visual: '画面A', shot_type: '近景' }], transcript: [{ t0: 0, t1: 4, text: '你好' }] }, { sourceName: 'demo.mp4', frames: 8, transcribed: true })
    check(report.includes('demo.mp4') && report.includes('近景') && report.includes('画面A') && report.includes('[0.0–4.0] 你好'), '报告含源名/景别/画面/转写段')
    const reportNo = renderAnalysisReportMd({ duration: 3, scenes: [], transcript: null }, { sourceName: 'x.mp4', frames: 2, transcribed: false })
    check(reportNo.includes('无（降级或无人声）') && reportNo.includes('未产出场景') && !reportNo.includes('## 音轨转写'), '无转写/无场景报告降级文案且不出转写节')

    // —— [P3] frame.ts 缩宽注入 + 缺省回归锚（不动画布现行为）——
    const { buildFrameExtractArgs } = await import('../src/services/creation/gen/frame')
    check(!buildFrameExtractArgs('a.mp4', 'b.jpg', 3).includes('-vf'), '缺省不注入 -vf（画布抽帧现行为逐字不变回归锚）')
    const scaled = buildFrameExtractArgs('a.mp4', 'b.jpg', 3, ANALYSIS_FRAME_WIDTH)
    check(scaled.includes('-vf') && scaled[scaled.indexOf('-vf') + 1] === 'scale=768:-2' && scaled[scaled.length - 1] === 'b.jpg', `缩宽注入 -vf scale=${ANALYSIS_FRAME_WIDTH}:-2（-2 保持宽高比）`)

    // —— [P3] ASR 纯函数面（判定/响应归一；网络面走实弹）——
    const { isOpenAiCompatBase, parseAsrResponse, DEFAULT_ASR_MODEL } = await import('../src/services/asr')
    check(isOpenAiCompatBase('https://api.siliconflow.cn/v1') === true, 'SiliconFlow /v1 根 → 兼容')
    check(isOpenAiCompatBase('https://api.siliconflow.cn/v1/') === true, '尾斜杠归一仍兼容')
    check(isOpenAiCompatBase('https://tts.vendor.com') === false, '非版本根 → 不兼容（自动降级）')
    check(isOpenAiCompatBase('') === false && isOpenAiCompatBase(null) === false, '空/null → 不兼容')
    const asrR = parseAsrResponse({ text: 'hello world', segments: [{ start: 1.5, end: 3.2, text: ' world' }, { start: 0, end: 1.5, text: 'hello' }, { start: 'x', text: 'bad' }] })
    check(asrR?.text === 'hello world' && asrR.segments?.length === 2 && asrR.segments[0]!.t0 === 0, 'segments 字段名兼容 start/end + 升序 + 非法项丢弃')
    check(parseAsrResponse({ text: '  ' }) === null && parseAsrResponse(null) === null, '空白 text/非对象 → null（失败降级）')
    check(parseAsrResponse({ text: 'ok' })?.segments === null, '有 text 无 segments → segments=null（仍算成功）')
    check(DEFAULT_ASR_MODEL === 'FunAudioLLM/SenseVoiceSmall', '缺省模型 SenseVoiceSmall')

    // —— [P3] G10 video-reverse 模板合法性（loader 同源校验，零落盘）——
    const { readFileSync } = await import('node:fs')
    const { validateTemplateText } = await import('../src/pipeline/loader')
    const vText = readFileSync(resolve(REPO_ROOT, 'workspace', 'templates', 'video-reverse.yaml'), 'utf8')
    const vRes = validateTemplateText(vText, 'video-reverse')
    check(vRes.ok === true, `video-reverse 模板校验 ok（errors=${JSON.stringify(vRes.errors)}）`)
    check(vRes.template?.steps.map((s) => s.action).join(',') === 'video_analyze,ai_text,ai_text', '步骤链：analyze→storyboard→copy（actions 全在 KNOWN_ACTIONS）')
    check(vRes.template?.steps[1]?.gate?.mode === 'required', 'storyboard 挂 required 审阅门控（spec §2.9 gate）')
  }

  const runners: Record<string, () => Promise<void>> = {
    docparse: sectionDocparse,
    'content-write': sectionContentWrite,
    'graph-layout': sectionGraphLayout,
    audit: sectionAudit,
    merge: sectionMerge,
    append: sectionAppend,
    fetch: sectionFetch,
    analyze: sectionAnalyze,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    // 注册面断言（先于分节，all 与单节都覆盖一次）
    console.log(`\n──── section: registry ────`)
    check(KNOWN_ACTIONS.includes('adapt_audit'), 'KNOWN_ACTIONS 含 adapt_audit')
    check(KNOWN_ACTIONS.includes('video_analyze'), 'KNOWN_ACTIONS 含 video_analyze')
    const keys = listActionKeys()
    check(keys.includes('adapt_audit') && keys.includes('video_analyze'), 'registry 同步注册两新 action')
    for (const name of wanted === 'all' ? SECTIONS : [wanted]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    console.log(`\n==== M25 探针结果: ${failed > 0 ? `${failed} 项失败` : '全部通过'} ====`)
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : 0
  }
}

void main()
