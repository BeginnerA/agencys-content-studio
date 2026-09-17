/** M22[P3] export-svg：布局图 SVG（纯函数矩阵 + 组框嵌套 + 存储归位）（断言体逐字搬自原 probe-m22.ts） */
import { readFileSync } from 'node:fs'
import type { CanvasDoc, CanvasDocGroup, CanvasDocNode } from '../../../src/services/creation/spec'
import type { M22Ctx } from './ctx'

export async function run(ctx: M22Ctx): Promise<void> {
  const { check, db, T0, projects, xmlEscape, truncTitle, svgBezier, svgNodeColor, computeSvgGroupBoxes, buildCanvasSvg, writeTextAsset, absPathOf } = ctx
  // ---- 纯函数矩阵 ----
  check(xmlEscape(`<a & b> "c" 'd'`) === '&lt;a &amp; b&gt; &quot;c&quot; &apos;d&apos;', 'xmlEscape：五类字符全转义')
  check(truncTitle('x'.repeat(16)) === 'x'.repeat(16) && truncTitle('x'.repeat(17)) === `${'x'.repeat(16)}…`, '标题截断：16 内原样 / 17 截 16 + …')
  check(svgBezier(0, 0, 100, 50) === 'M 0 0 C 50 0, 50 50, 100 50', '贝塞尔：dx=|Δx|/2（远距）')
  check(svgBezier(0, 0, 10, 10) === 'M 0 0 C 48 0, -38 10, 10 10', '贝塞尔：dx=48 下限（近距/回连）')
  check(svgNodeColor({ kind: 'gen', spec: { genKind: 'video', prompt: 'p' } }) === '#3b82f6', '色板：gen video → 蓝')
  check(
    svgNodeColor({ kind: 'gen', spec: { genKind: 'zzz', prompt: 'p' } as unknown as CanvasDocNode['spec'] }) === '#8b5cf6' &&
      svgNodeColor({ kind: 'gen', spec: null }) === '#8b5cf6',
    '色板：未知/缺 genKind → 默认（image 紫）',
  )
  check(svgNodeColor({ kind: 'asset', spec: null }) === '#64748b' && svgNodeColor({ kind: 'run', spec: null }) === '#ef4444', '色板：asset 灰 / run 红')

  // ---- 组框：嵌套包围盒 + depth 排序 + 空组退化 ----
  const mkDocNode = (id: number, kind: CanvasDocNode['kind'], x: number, y: number, extra: Partial<CanvasDocNode> = {}): CanvasDocNode => ({
    id,
    kind,
    x,
    y,
    title: `N${id}`,
    groupId: null,
    assetId: null,
    asset: null,
    spec: null,
    specError: null,
    status: null,
    latestTask: null,
    tasks: [],
    readiness: null,
    editCapability: null,
    canRun: null,
    canCancel: null,
    ...extra,
  })
  const gp: CanvasDocGroup = { id: 101, title: '父组P', color: 'blue', collapsed: false, x: 0, y: 0, parentId: null }
  const ga: CanvasDocGroup = { id: 102, title: '组A', color: null, collapsed: false, x: 0, y: 0, parentId: 101 }
  const gb: CanvasDocGroup = { id: 103, title: '组B', color: 'green', collapsed: false, x: 0, y: 0, parentId: 101 }
  const ge: CanvasDocGroup = { id: 104, title: '空组', color: null, collapsed: false, x: 2000, y: 300, parentId: 101 }
  const dN1 = mkDocNode(1, 'asset', 100, 200, { groupId: ga.id, title: '<A&B "q">' })
  const dN2 = mkDocNode(2, 'gen', 400, 200, { groupId: ga.id, spec: { genKind: 'video', prompt: 'p' }, title: 'x'.repeat(20) })
  const dN3 = mkDocNode(3, 'text', 100, 600, { groupId: gb.id, spec: { text: 't' } })
  const boxes = computeSvgGroupBoxes([dN1, dN2, dN3], [gp, ga, gb, ge])
  check(
    boxes.length === 4 && boxes[0]!.id === gp.id && boxes[1]!.id === ga.id && boxes[2]!.id === gb.id && boxes[3]!.id === ge.id,
    '组框：depth 升序（父先）+ 同层按 id',
  )
  check(boxes[0]!.depth === 0 && boxes[1]!.depth === 1, '组框：深度标注（0 父 / 1 子）')
  const boxA = boxes[1]!
  check(boxA.x === 88 && boxA.y === 166 && boxA.w === 544 && boxA.h === 186, '组框：包围盒公式（x−12 / y−34 / w+24 / h+46）')
  check(boxes[3]!.x === 2000 && boxes[3]!.y === 300 && boxes[3]!.w === 220 && boxes[3]!.h === 120, '空组退化：存储坐标 + 220×120')

  // ---- 主函数：视口并集 + 渲染结构 ----
  const docS: CanvasDoc = {
    canvas: { id: 1, projectId: 1, name: '导出', viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [dN1, dN2, dN3],
    edges: [
      { id: 1, from: dN1.id, to: dN2.id, port: 'reference' },
      { id: 2, from: dN2.id, to: 999, port: 'prompt' },
    ],
    groups: [gp, ga, gb, ge],
  }
  const svg = buildCanvasSvg(docS)
  check(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'), 'SVG 根元素开闭')
  check((svg.match(/rx="8"/g) ?? []).length === 3, '节点卡 rect 数 = 节点数（rx=8 唯一标识）')
  check((svg.match(/rx="12"/g) ?? []).length === 4, '组框 rect 数 = 组数（rx=12）')
  check((svg.match(/marker-end="url\(#m22-arrow\)"/g) ?? []).length === 1, '边 path 数 = 端点齐全边数（悬空边跳过）')
  check(svg.includes('&lt;A&amp;B &quot;q&quot;&gt;') && !svg.includes('<A&B'), '节点标题 XML 转义')
  check(svg.includes(`${'x'.repeat(16)}…`), '长标题截断入图')
  check(svg.includes('M 320 270 C 368 270, 352 270, 400 270'), '边几何：源右中 → 目标左中（dx=48 下限）')
  const svgEmpty = buildCanvasSvg({ canvas: { id: 2, projectId: 1, name: '空', viewport: { x: 0, y: 0, zoom: 1 } }, nodes: [], edges: [], groups: [] })
  check(svgEmpty.includes('width="980" height="720" viewBox="-40 -40 980 720"'), '空画布：兜底视口 900×640 + 40 padding')
  const svgFar = buildCanvasSvg({
    canvas: { id: 3, projectId: 1, name: '远', viewport: { x: 0, y: 0, zoom: 1 } },
    nodes: [mkDocNode(9, 'text', 1000, 100, { spec: { text: 't' } })],
    edges: [],
    groups: [],
  })
  check(svgFar.includes('width="1300" height="720" viewBox="-40 -40 1300 720"'), '视口并集：右超出节点（1000+220 → 1220 + 40×2）')

  // ---- 存储归位：writeTextAsset(svg) ----
  const [projE] = await db
    .insert(projects)
    .values({ name: 'M22 导出项目', genre: 'other', templateKey: 'mengbao-episode', settings: '{}', tags: '[]', createdAt: T0, updatedAt: T0 })
    .returning()
  const w = await writeTextAsset(projE!.id, { name: '布局图.svg', content: svg, purpose: 'creation_svg', format: 'svg', params: { canvasId: 1 } })
  check(w.kind === 'text' && w.mime === 'image/svg+xml' && w.ext === 'svg', 'writeTextAsset(svg)：mime/ext 就位')
  check((w.relPath ?? '').includes('exports'), 'svg 归位 exports 子目录')
  check(w.relPath != null && readFileSync(absPathOf(w.relPath), 'utf8') === svg, 'svg 全文落盘往返一致')
}
