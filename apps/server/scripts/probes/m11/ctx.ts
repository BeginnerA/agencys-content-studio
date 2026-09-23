/**
 * [M11·拆分] probe-m11 拆分后的共享上下文契约（≤800 行红线拆分，行为零变更：
 * section 模块只接收 ctx 注入 + 自行动态 import 运行期服务，断言文案逐字保留自原单文件）。
 * 隔离环境（临时库 + workspace）由入口 probe-m11.ts 在任何 src 加载前建立；
 * 本目录模块只被入口在 setup 后动态 import，src 动态 import 顺序与拆分前等价。
 */
export interface M11Ctx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any // drizzle 单例（探针脚本保持拆分前的宽松用法）
  pid: number
  T0: number
  REPO_ROOT: string
  check: (cond: boolean, msg: string) => void
  errOf: (fn: () => Promise<unknown>) => Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRun: (id: number) => Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getStep: (id: number) => Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAsset: (id: number) => Promise<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTask: (id: number) => Promise<any>
  setRunStatus: (id: number, status: string) => Promise<unknown>
  setStepStatus: (id: number, status: string) => Promise<unknown>
  mkStep: (runId: number, seq: number, stepKey: string, actionKey: string, status?: string) => Promise<number>
  /** 种子 run（completed；5 步骤 / 4 任务 / 2 资产），字段语义见入口注释 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seedRun: () => Promise<any>
  absPathOf: (rel: string) => string
  ensureProjectDirs: (pid: number) => void
  registerAsset: (
    pid: number,
    data: {
      name: string
      kind: 'image' | 'video' | 'audio' | 'text'
      purpose?: string
      relPath: string
      mime?: string
      ext?: string
      fileSize?: number
      params?: Record<string, unknown>
      runId?: number | null
      [k: string]: unknown
    },
  ) => Promise<{ id: number }>
  relPathOf: (projectId: number, purpose: string | null | undefined, fileName: string) => string
}
