import { PNG } from 'pngjs'

// TASK-2356 — test-only image builder, kept out of *.test.ts so importing it
// never re-registers another file's tests.

/** A w×h PNG, grey, with the first `changed` pixels painted red. */
export function png(w: number, h: number, changed = 0): Buffer {
  const img = new PNG({ width: w, height: h })
  for (let i = 0; i < w * h; i++) {
    const red = i < changed
    img.data[i * 4] = red ? 255 : 128
    img.data[i * 4 + 1] = red ? 0 : 128
    img.data[i * 4 + 2] = red ? 0 : 128
    img.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(img)
}
