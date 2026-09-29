/**
 * log —— 有上限的日志写入。全部 best-effort：日志失败绝不影响主流程。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 日志文件上限；超过则截断保留后一半。 */
export const MAX_LOG_BYTES = 512 * 1024

/**
 * 创建一个写日志函数。
 * @param {string} file - 日志文件绝对路径。
 * @returns {(message: string) => void} 写一行的函数（永不抛异常）。
 */
export function createLogger(file) {
  return function log(message) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        const text = readFileSync(file, 'utf8')
        writeFileSync(file, text.slice(Math.floor(text.length / 2)), 'utf8')
      }
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch {
      /* best-effort：日志失败不影响主流程 */
    }
  }
}
