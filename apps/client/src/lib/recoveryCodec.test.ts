import { describe, expect, it } from 'vitest'
import {
  createRecoveryChunkDocument,
  decodeRecoveryChunkDocument,
  MAX_SINGLE_NATIVE_RECOVERY_BYTES,
  RECOVERY_CHUNK_SOURCE_CHARACTERS,
  recoveryChunkCount,
  utf8ByteLength,
} from './recoveryCodec'

describe('recovery chunk framing', () => {
  it('counts UTF-8 without a payload-sized TextEncoder allocation', () => {
    expect(MAX_SINGLE_NATIVE_RECOVERY_BYTES).toBe(12 * 1024 * 1024)
    expect(utf8ByteLength('a戒😀')).toBe(8)
    expect(utf8ByteLength('\ud800')).toBe(3)
  })

  it('round-trips ordered parts with per-part SHA-256 integrity', async () => {
    const source = `${'x'.repeat(RECOVERY_CHUNK_SOURCE_CHARACTERS)}-tail`
    const setId = '11111111-1111-4111-8111-111111111111'
    const count = recoveryChunkCount(source)
    const decoded: string[] = []
    for (let index = 0; index < count; index += 1) {
      const part = source.slice(
        index * RECOVERY_CHUNK_SOURCE_CHARACTERS,
        (index + 1) * RECOVERY_CHUNK_SOURCE_CHARACTERS,
      )
      const document = await createRecoveryChunkDocument(part, setId, index + 1, count)
      const restored = await decodeRecoveryChunkDocument(JSON.parse(document))
      expect(restored.metadata).toMatchObject({ setId, partNumber: index + 1, partCount: count })
      decoded.push(restored.source)
    }
    expect(decoded.join('')).toBe(source)
  })

  it('rejects a modified encoded payload', async () => {
    const document = JSON.parse(await createRecoveryChunkDocument(
      'evidence',
      '22222222-2222-4222-8222-222222222222',
      1,
      1,
    )) as { payload: { data: string } }
    document.payload.data = `${document.payload.data.slice(0, -4)}AAAA`
    await expect(decodeRecoveryChunkDocument(document)).rejects.toThrow('校验失败')
  })
})
