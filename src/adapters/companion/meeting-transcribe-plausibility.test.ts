// TASK-2011 — refuse a transcript whose segments cannot be true.
//
// The numbers below are not invented. On 2026-09-17 a real transcription of
// meeting m-mu57vo0m-imo2oh wrote 13 mic segments holding up to 299 characters
// inside 10 ms, sixteen of them sharing one start offset. Nothing noticed. A note
// was drafted from those segments and saved to the vault, and its ▶ stamps were
// 2 minutes 12 seconds away from where the words were actually spoken — measured
// by re-sending the same audio, which came back well formed.
//
// The loopback track of that same meeting was clean. That is the control this
// file keeps: a check that flagged both tracks would be worthless, because it
// would fire on every meeting and get switched off within a week.

import { describe, it, expect } from 'vitest'
import { findImplausibleSegments, MAX_CHARS_PER_SECOND } from './meeting-transcribe'
import type { TranscriptSegment } from './meeting-transcribe'

function seg(over: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    track: 'mic',
    speaker: 'Me',
    locale: 'vi-VN',
    startMs: 0,
    endMs: 5000,
    text: 'một câu bình thường',
    ...over
  } as TranscriptSegment
}

describe('AC — a segment that cannot be spoken in the time it claims is rejected', () => {
  it('flags the real 299-characters-in-10ms segment', () => {
    const bad = seg({
      startMs: 767500,
      endMs: 767510,
      text: 'Bây giờ có 2 cái nhá cái đầu tiên á là tùng sẽ làm thêm cái chức năng trên cái màn hình platform để cho chị chọn cái applicable rubric và access và cái currency cho từng cái câu hỏi rồi chị cho em thêm 1 cái chỗ nữa là cái phần mà để sau này hỗ trợ cho cái cái assetment report á là mắt bình thường.'
    })
    expect(findImplausibleSegments([bad])).toHaveLength(1)
  })

  it('flags a zero-length span that still carries words', () => {
    expect(findImplausibleSegments([seg({ startMs: 1000, endMs: 1000, text: 'có chữ' })])).toHaveLength(1)
  })

  it('flags a negative span', () => {
    expect(findImplausibleSegments([seg({ startMs: 2000, endMs: 1000 })])).toHaveLength(1)
  })
})

describe('AC — the control: ordinary speech is left alone', () => {
  // Without these, a check that returned every segment would pass the tests above
  // while making transcription impossible.
  it('accepts a real segment at a normal speaking rate', () => {
    // 44 characters over 6 seconds ≈ 7 chars/s, a quarter of ordinary speech.
    const ok = seg({ startMs: 44000, endMs: 50000, text: 'Còn cái này là em chỉ quan tâm đến gì mà liên' })
    expect(findImplausibleSegments([ok])).toHaveLength(0)
  })

  it('accepts fast speech right up to the ceiling, and rejects just past it', () => {
    const oneSecond = 1000
    const atCeiling = seg({ startMs: 0, endMs: oneSecond, text: 'x'.repeat(MAX_CHARS_PER_SECOND) })
    const pastCeiling = seg({ startMs: 0, endMs: oneSecond, text: 'x'.repeat(MAX_CHARS_PER_SECOND + 1) })
    expect(findImplausibleSegments([atCeiling])).toHaveLength(0)
    expect(findImplausibleSegments([pastCeiling])).toHaveLength(1)
  })

  it('ignores an empty segment rather than calling it impossible', () => {
    expect(findImplausibleSegments([seg({ startMs: 10, endMs: 10, text: '   ' })])).toHaveLength(0)
  })

  it('returns only the offenders when a transcript mixes both', () => {
    const good = seg({ startMs: 0, endMs: 8000, text: 'một câu nói bình thường trong tám giây' })
    const bad = seg({ startMs: 8000, endMs: 8010, text: 'x'.repeat(200) })
    const found = findImplausibleSegments([good, bad, good])
    expect(found).toHaveLength(1)
    expect(found[0].startMs).toBe(8000)
  })
})
