/**
 * M3 探针（记忆/角色/契约/情绪/对齐/模板）——手动执行：
 *   cd apps/server && npx tsx scripts/probe-m3.ts [--section=migrate|memory|...]
 *
 * 隔离策略：CSTUDIO_DATA / CSTUDIO_WORKSPACE 指向一次性临时目录（独立 studio.db + workspace），
 * 不触碰开发库（同 probe-m2a）。
 *
 * section（默认 all = 全部已实现；未列出的 section 由后续任务逐段加入）：
 *   migrate  空库 migrate 自动建 memories/characters 两表 + 4 索引
 *   memory   embedding 服务冒烟（维度 / cosine / status）；upsert/recall/reindex 断言随 Task 4 加入
 *
 * 退出码：0 = 全部断言通过；1 = 有 FAIL；2 = 前置缺失（模型未就绪，memory 相关 section 输出 SKIP）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..') // apps/server/scripts -> 仓库根

// ---- 隔离环境：必须在任何 src 模块加载前设置 ----
// 清理历史残留：libsql 在 Windows 下不释放文件句柄（close 后仍 EBUSY）——本进程退出时 db 文件必留；
// 本次运行在创建自己的目录前清掉旧的（占用中则跳过，自动收敛为最多一份）。
const TMP_PREFIX = 'acs-probe-m3-'
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(TMP_PREFIX)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    } catch { /* 占用中（并行探针）→ 跳过 */ }
  }
}
const TMP = mkdtempSync(join(tmpdir(), TMP_PREFIX))
process.env.CSTUDIO_ROOT = REPO_ROOT
process.env.CSTUDIO_DATA = join(TMP, 'data')
process.env.CSTUDIO_WORKSPACE = join(TMP, 'workspace')
mkdirSync(process.env.CSTUDIO_DATA, { recursive: true })
mkdirSync(process.env.CSTUDIO_WORKSPACE, { recursive: true })

const SECTIONS = ['migrate', 'memory'] as const

async function main(): Promise<void> {
  // src 模块全部动态加载（环境变量已隔离）
  const { initDb, sqlite } = await import('../src/db')
  const { createLogger } = await import('../src/logger')

  const log = createLogger('probe-m3')
  let failed = 0
  let skipReason: string | null = null
  const check = (cond: boolean, msg: string): void => {
    if (cond) log.info(`  PASS  ${msg}`)
    else {
      failed += 1
      log.error(`  FAIL  ${msg}`)
    }
  }

  /**
   * 模型桥接：隔离环境把 data/ 指向临时目录，而模型（45MB）属外部资产——
   * 建 junction（零拷贝）把隔离 data/models 指向仓库真实 data/models；无真模型则留空（status 报 SKIP）。
   * junction 失败退化为按目录复制。
   */
  const bridgeModels = async (): Promise<void> => {
    const realModels = join(REPO_ROOT, 'data', 'models')
    const tmpModels = join(process.env.CSTUDIO_DATA!, 'models')
    if (existsSync(tmpModels) || !existsSync(realModels)) return
    try {
      symlinkSync(realModels, tmpModels, 'junction')
      log.info(`模型目录已 junction：${tmpModels} → ${realModels}`)
    } catch (e) {
      log.warn(`junction 失败（${(e as Error).message}），退化为复制…`)
      cpSync(realModels, tmpModels, { recursive: true })
    }
  }

  // ================= sections =================

  const sectionMigrate = async (): Promise<void> => {
    await initDb()
    const r = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('memories','characters') ORDER BY name",
    )
    const names = (r.rows as unknown as Array<{ name: string }>).map((x) => x.name)
    check(names.join(',') === 'characters,memories', `memories/characters 两表存在（${names.join(',')}）`)
    const ri = await sqlite.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_memories_project','idx_memories_name','idx_characters_project','idx_characters_name')",
    )
    check(ri.rows.length === 4, `4 个索引存在（实际 ${ri.rows.length}）`)
  }

  const sectionMemory = async (): Promise<void> => {
    await initDb()
    await bridgeModels()
    const { embed, cosine, embeddingStatus } = await import('../src/services/embedding')
    const st0 = await embeddingStatus()
    log.info(`embeddingStatus: ready=${st0.ready} modelName=${st0.modelName} dims=${st0.dims} dir=${st0.modelDir}`)
    if (!st0.ready) {
      skipReason = `embedding 模型未就绪：${st0.error}`
      log.warn(`SKIP  memory section —— ${skipReason}`)
      return
    }
    const v = await embed('阳光明媚，正适合户外走走')
    check(v.length > 0, `embed 维度 > 0（${v.length}）`)
    const self = cosine(v, v)
    check(Math.abs(self - 1) < 1e-3, `cosine 自相似 ≈ 1（${self.toFixed(4)}）`)
    const st1 = await embeddingStatus()
    check(st1.dims === v.length, `status 维度与实测一致（${st1.dims} === ${v.length}）`)
    // Task 4 续：upsertMemory 3 条 → 近义检索 top1 命中 → 同名 upsert 幂等 → reindex 计数
  }

  // ================= 分发 =================

  const runners: Record<string, () => Promise<void>> = {
    migrate: sectionMigrate,
    memory: sectionMemory,
  }
  const arg = process.argv.find((a) => a.startsWith('--section='))
  const wanted = arg ? arg.slice('--section='.length) : 'all'
  if (wanted !== 'all' && !(SECTIONS as readonly string[]).includes(wanted)) {
    log.error(`未知 section：${wanted}（已实现：${SECTIONS.join(' / ')}；all = 全部）`)
    process.exitCode = 1
    return
  }

  try {
    for (const name of wanted === 'all' ? SECTIONS : [wanted]) {
      console.log(`\n──── section: ${name} ────`)
      await runners[name]!()
    }
  } catch (err) {
    failed += 1
    console.error(`\n探针异常终止: ${(err as Error).stack ?? err}`)
  } finally {
    const verdict =
      failed > 0 ? `${failed} 项失败` : skipReason ? `SKIP（${skipReason}）` : '全部通过'
    console.log(`\n==== M3 探针结果: ${verdict} ====`)
    try {
      sqlite.close() // 释放 db 连接（Windows 下句柄可能仍被 libsql 持有 → 失败不阻断）
    } catch { /* 已关闭或未初始化 */ }
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {
      console.log(`临时目录未完全清理（Windows libsql 句柄；下次运行自动清理）: ${TMP}`)
    }
    process.exitCode = failed > 0 ? 1 : skipReason ? 2 : 0
  }
}

void main()
