/** 把长文本切成稳定的小段，给数据库检索 / 后续语义索引使用 */
export function memoryChunks(text: string, maxChars = 1800, overlap = 180): string[] {
  const src = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!src) return []
  if (src.length <= maxChars) return [src]

  const chunks: string[] = []
  let start = 0
  while (start < src.length) {
    let end = Math.min(start + maxChars, src.length)
    if (end < src.length) {
      const floor = Math.min(end, start + Math.floor(maxChars * 0.6))
      const window = src.slice(floor, end)
      const rel = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('。'))
      if (rel >= 0) end = floor + rel + 1
    }
    if (end <= start) end = Math.min(start + maxChars, src.length)
    const chunk = src.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= src.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return chunks
}

export const MD_MAX_BYTES = 512 * 1024
export const MD_MAX_FILES = 10

/** 标题优先取文件里的第一个 markdown 标题，其次用文件名 */
export function mdTitle(text: string, filename: string): string {
  const m = text.match(/^#{1,3}\s+(.+)$/m)
  if (m) return m[1].trim().slice(0, 60)
  return filename.replace(/\.(md|markdown|mdx|txt)$/i, '').slice(0, 60)
}

/** 只接受文本类文件，别的拖进来直接提示 */
export function isMarkdown(file: { name: string; type?: string }): boolean {
  return /\.(md|markdown|mdx|txt)$/i.test(file.name) || file.type === 'text/markdown'
}

/** 拖拽事件里是否夹带文件 */
export function hasFiles(e: { dataTransfer?: { types?: unknown } | null }): boolean {
  const dt = e.dataTransfer
  return !!dt && Array.from((dt.types || []) as unknown[]).includes('Files')
}
