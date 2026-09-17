import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import dotenv from 'dotenv'

/**
 * 定位仓库根：优先 CSTUDIO_ROOT，否则沿 cwd 向上找 pnpm-workspace.yaml。
 * 保证从任意子包 cwd 启动都能解析 workspace/、data/、.env。
 */
export function resolveRoot(): string {
  if (process.env.CSTUDIO_ROOT) return resolve(process.env.CSTUDIO_ROOT)
  let dir = process.cwd()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

// 仓库根 .env 先行加载（幂等，环境变量已存在时不覆盖）
export const ROOT = resolveRoot()
dotenv.config({ path: join(ROOT, '.env') })

export const WORKSPACE_DIR = resolve(process.env.CSTUDIO_WORKSPACE ?? join(ROOT, 'workspace'))
export const DATA_DIR = resolve(process.env.CSTUDIO_DATA ?? join(ROOT, 'data'))
export const TEMPLATES_DIR = join(WORKSPACE_DIR, 'templates')
export const PROMPTS_DIR = join(WORKSPACE_DIR, 'prompts')
export const PROJECTS_DIR = join(WORKSPACE_DIR, 'projects')
export const RUN_LOGS_DIR = join(WORKSPACE_DIR, 'logs', 'runs')

/** [M24] 合规词库目录（本地数据文件，零外部服务；words.txt 行格式 类别|词|级别） */
export const COMPLIANCE_DIR = join(WORKSPACE_DIR, 'compliance')

/** [M19] 平台品牌资材目录（水印/片头/片尾文件；品牌三层模型的平台级 file 键落点） */
export const BRAND_DIR = join(WORKSPACE_DIR, 'brand')

/** [M14] Web 构建产物目录（桌面端 / 单端口部署的静态托管源；默认 apps/web/dist） */
export const WEB_DIST = resolve(process.env.CSTUDIO_WEB_DIST ?? join(ROOT, 'apps', 'web', 'dist'))

/** 仅在需要时读取本地密钥文件 data/secrets.json */
export function loadLocalSecrets(): Record<string, string> {
  const file = join(DATA_DIR, 'secrets.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export function getEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

export const env = {
  port: Number(getEnv('CSTUDIO_PORT', '3001')),
  logLevel: getEnv('CSTUDIO_LOG_LEVEL', 'info'),
  llm: {
    baseUrl: getEnv('AGENT_LLM_BASE_URL', ''),
    apiKey: getEnv('AGENT_LLM_API_KEY', ''),
    model: getEnv('AGENT_LLM_MODEL', 'deepseek-chat'),
  },
  ffmpegPath: getEnv('CSTUDIO_FFMPEG_PATH', ''),
  ffprobePath: getEnv('CSTUDIO_FFPROBE_PATH', ''),
}
