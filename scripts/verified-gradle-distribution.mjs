import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'

export async function sha256Stream(pathname) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(pathname)) digest.update(chunk)
  return digest.digest('hex')
}

export async function verifyLocalGradleDistribution(pathname, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw new Error('Gradle 分发固定 SHA-256 格式错误')
  let fileStat
  try {
    fileStat = await lstat(pathname)
  } catch {
    throw new Error(`未找到本地 Gradle 分发 ZIP：${pathname}`)
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('本地 Gradle 分发必须是普通 ZIP 文件')
  const actualSha256 = await sha256Stream(pathname)
  if (actualSha256 !== expectedSha256) {
    throw new Error(`本地 Gradle 分发 SHA-256 不匹配：期望 ${expectedSha256}，实际 ${actualSha256}`)
  }
  return { pathname: path.resolve(pathname), sha256: actualSha256, sizeBytes: fileStat.size }
}

export function validateGradleDistributionEntries(listing, expectedRoot) {
  if (!/^[A-Za-z0-9._-]+$/.test(expectedRoot ?? '')) throw new Error('Gradle 分发根目录名非法')
  const entries = String(listing).split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) throw new Error('Gradle 分发 ZIP 为空')
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/')
    if (
      normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || normalized.split('/').includes('..')
      || (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`))
    ) throw new Error(`Gradle 分发 ZIP 路径越界：${entry}`)
  }
  const executable = `${expectedRoot}/bin/${process.platform === 'win32' ? 'gradle.bat' : 'gradle'}`
  if (!entries.includes(executable)) throw new Error(`Gradle 分发 ZIP 缺少入口：${executable}`)
  return { entryCount: entries.length, executable }
}
