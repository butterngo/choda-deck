const LEAK_MARKERS = [
  '</resumePoint>',
  '<parameter name',
  '<parameter ',
  '<invoke ',
  '<invoke>',
  '</invoke>',
  '<',
  '</',
  '<function_calls>',
  '</function_calls>'
]

export function stripToolCallLeak(text: string | null | undefined): string {
  if (!text) return ''
  let earliest = -1
  for (const marker of LEAK_MARKERS) {
    const idx = text.indexOf(marker)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx
    }
  }
  if (earliest === -1) return text
  return text.slice(0, earliest).trimEnd()
}
