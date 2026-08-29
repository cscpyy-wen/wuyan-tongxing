export const CHROMIUM_LOCAL_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024
export const SAFE_LOCAL_STORAGE_OPERATIONAL_BYTES = 9 * 1024 * 1024

export interface StringStorageArea {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
}

/**
 * Blink's DOM-storage quota accounting charges two bytes for every UTF-16 code
 * unit in both keys and values, regardless of the string's internal backing.
 * Keep this allocation-free because it runs immediately before every write.
 */
export function conservativeStorageBytes(value: string): number {
  return value.length * 2
}

export function projectedStorageAreaBytes(
  storage: StringStorageArea,
  replacementKey: string,
  replacementValue: string,
): number {
  let bytes = conservativeStorageBytes(replacementKey) + conservativeStorageBytes(replacementValue)
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key === null || key === replacementKey) continue
    const value = storage.getItem(key)
    if (value === null) continue
    bytes += conservativeStorageBytes(key) + conservativeStorageBytes(value)
    if (bytes > SAFE_LOCAL_STORAGE_OPERATIONAL_BYTES) return bytes
  }
  return bytes
}

export function assertProjectedTaroWriteFits(
  storage: StringStorageArea,
  key: string,
  value: unknown,
): void {
  const wrapper = JSON.stringify({ data: value })
  if (projectedStorageAreaBytes(storage, key, wrapper) > SAFE_LOCAL_STORAGE_OPERATIONAL_BYTES) {
    throw new Error('本机存储接近安全容量上限，请先导出或清理旧记录')
  }
}
