/**
 * 落库前清洗对外错误文案（共享小函数）。
 *
 * 消费方：图像能力解析失败说明、逐角色一致性评分失败说明——两者的 note 都会持久化
 * （参数快照 / 评价结果表），经只读端点原样回显，还会被门禁 checker 塞进问题证据。
 * 端点配置里同时存着密钥与完整 baseUrl，而供应商/kit 的错误文案常把实例名、baseUrl 或
 * 密钥片段复述进异常信息（「实例「…」缺少 baseUrl」这类句式直接把用户填的名称带出来），
 * 原样落盘等于把凭据抄进一个可被任意读取的文件。
 *
 * 三步走：压平换行与连续空白（保持单行，也堵住借换行伪造日志行）；
 * 把 URL 片段与形似密钥的长串整体换成占位文字（保住「哪一类环节出了什么问题」的诊断线索，只去掉凭据本身）；
 * 截断到固定长度（错误文案可达数 KB，一条降级说明不该独占整份留痕）。
 */

/** 会被换行/连续空白压平后写进失败说明的原始错误文案；URL 与密钥片段在写库前抹除，见 sanitizeErrorNote */
const URL_FRAGMENT = /https?:\/\/[^\s"'“”‘’（）()【】〔〕《》「」，。；、！？]+/gi
/** 形似供应商标识的密钥（sk- 开头跟 6 位以上字母数字下划线连字符，OpenAI/智谱/月之暗面等的通行前缀） */
const SK_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{6,}/g
/** 无明显前缀但长度已达凭据级别的连续字母数字（令牌、签名串、端点指纹哈希） */
const LONG_TOKEN = /\b[A-Za-z0-9]{24,}\b/g
/** 失败说明保留的最大字符数：超出即截断（共享预算，能力说明与评分说明同款形态） */
const ERROR_NOTE_MAX_CHARS = 160

/**
 * 任意抛出值 → 单行清洗文案（压平 → 掩码 → 截断）。
 * 抛出的未必是 Error（第三方可能丢一个无 message 的对象），兜成空串让留痕退化为「只有前缀」而非二次抛错。
 */
export function sanitizeErrorNote(raw: unknown): string {
  const collapsed = String(raw ?? '').replace(/\s+/g, ' ').trim()
  const masked = collapsed
    .replace(URL_FRAGMENT, '[已隐去地址]')
    .replace(SK_STYLE_KEY, '[已隐去密钥]')
    .replace(LONG_TOKEN, '[已隐去密钥]')
  return masked.length > ERROR_NOTE_MAX_CHARS ? `${masked.slice(0, ERROR_NOTE_MAX_CHARS)}…` : masked
}
