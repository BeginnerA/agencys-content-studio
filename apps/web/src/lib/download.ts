// ===== 浏览器文件下载触发（剪辑工程交换包等多处复用，临时 a[download] 直连资产端点） =====

/**
 * 以隐藏 <a download> 触发浏览器下载给定 URL（免 token 的资产文件端点）。
 * 端点自身带 Content-Disposition，name 仅作兜底文件名。
 */
export function triggerDownload(url: string, name = ''): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
