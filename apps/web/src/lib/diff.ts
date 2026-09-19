// ===== [M21] 行级文本 diff（零依赖自研 LCS） =====
// GateDialog「对比」tab 使用：公共前后缀裁剪 + DP 求 LCS 后回溯输出行序列。
// 规模保护：单侧行数上限 MAX_LINES（超出截断）；差异段 DP 规模超限时退化为整段替换。

export interface DiffRow {
  type: 'same' | 'add' | 'del'
  text: string
}

export interface DiffResult {
  rows: DiffRow[]
  /** 是否因规模保护被截断/退化（UI 显示提示） */
  truncated: boolean
}

/** 单侧文本行数上限（超出只取前 N 行参与对比） */
const MAX_LINES = 5000
/** 差异段 DP 单元格上限（超限退化整段替换，防大文本卡顿） */
const MAX_CELLS = 4_000_000

/** 行级 diff：旧文本 → 新文本（same 上下文 / del 删行 / add 增行） */
export function diffLines(oldText: string, newText: string): DiffResult {
  let a = oldText.split(/\r?\n/)
  let b = newText.split(/\r?\n/)
  let truncated = false
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    truncated = true
    a = a.slice(0, MAX_LINES)
    b = b.slice(0, MAX_LINES)
  }

  // 公共前缀/后缀不进 DP（改动居中的常见场景可大幅裁剪规模）
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }

  const rows: DiffRow[] = []
  for (let i = 0; i < start; i += 1) rows.push({ type: 'same', text: a[i]! })

  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)

  if (midA.length && midB.length && midA.length * midB.length <= MAX_CELLS) {
    // LCS DP（自底向上；Uint32Array 平铺 (m+1)x(n+1)）
    const m = midA.length
    const n = midB.length
    const W = n + 1
    const dp = new Uint32Array((m + 1) * W)
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i * W + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * W + j + 1]! + 1
            : Math.max(dp[(i + 1) * W + j]!, dp[i * W + j + 1]!)
      }
    }
    // 回溯：相等取 same；否则朝 LCS 更大的方向（删优先输出，保证 - 在 + 前）
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        rows.push({ type: 'same', text: midA[i]! })
        i += 1
        j += 1
      } else if (dp[(i + 1) * W + j]! >= dp[i * W + j + 1]!) {
        rows.push({ type: 'del', text: midA[i]! })
        i += 1
      } else {
        rows.push({ type: 'add', text: midB[j]! })
        j += 1
      }
    }
    while (i < m) {
      rows.push({ type: 'del', text: midA[i]! })
      i += 1
    }
    while (j < n) {
      rows.push({ type: 'add', text: midB[j]! })
      j += 1
    }
  } else {
    // 规模保护退化：两侧都有内容且乘积超限才标截断；单侧为空是精确结果（纯新增/纯删除）
    if (midA.length && midB.length) truncated = true
    for (const t of midA) rows.push({ type: 'del', text: t })
    for (const t of midB) rows.push({ type: 'add', text: t })
  }

  // 公共后缀（a / b 同源，取 a 侧即可）
  for (let i = endA + 1; i < a.length; i += 1)
    rows.push({ type: 'same', text: a[i]! })
  return { rows, truncated }
}
