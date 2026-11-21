import type { ReactNode, Ref } from 'react'
import { MacPointer, MacPointingHand } from './cursors'
import type { Point } from './measure'
import './cursor.css'

// The cursor a stage draws: the glyph for each kind, where its hotspot sits,
// the styles, and the ripple a click can send out. Ported from the stageshow
// kit (MIT, see LICENSE) and trimmed to what the home hero draws: the macOS
// arrow and pointing hand, and the touch dot for the phone-width design.

/** pointer: the arrow. hand: the pointing hand, for links and buttons. The
 * other kinds are kept in the type so the script API is unchanged; they draw
 * the arrow. */
export type CursorKind = 'pointer' | 'ibeam' | 'crosshair' | 'hand' | 'open' | 'grab' | 'wait' | 'resize-ns' | 'resize-ew' | 'resize-nwse' | 'resize-nesw'
/**
 * real: the macOS pointer. touch: a finger on a phone, shown only where it
 * touches (a soft dot that lands on press and fades), invisible between taps.
 */
export type CursorStyle = 'real' | 'large' | 'circle' | 'touch' | 'arrow'

type Drawn = 'pointer' | 'hand'
const GLYPHS: Record<Drawn, () => ReactNode> = { pointer: MacPointer, hand: MacPointingHand }

// Where each glyph's hotspot sits inside its box, so the point is the click.
const HOTSPOT: Record<Drawn, Point> = {
  pointer: { x: 7.5, y: 5.25 },
  hand: { x: 9.75, y: 3.25 },
}

/** The cursor element. The stage moves it (a transform on cursorRef) and marks it pressed or idle. */
export function Cursor({ cursorRef, style = 'real', kind }: { cursorRef: Ref<HTMLDivElement>; style?: CursorStyle; kind: CursorKind }) {
  const shown: Drawn = kind === 'hand' ? 'hand' : 'pointer'
  return (
    <div ref={cursorRef} className="ss-cursor" data-style={style} data-kind={kind} aria-hidden>
      {style === 'touch' && <span className="ss-cursor__streak" />}
      <div className="ss-cursor__press">
        {(style === 'circle' || style === 'touch') && <span className="ss-cursor__dot" />}
        {style !== 'circle' &&
          style !== 'touch' &&
          (Object.keys(GLYPHS) as Drawn[]).map((k) => {
            const Glyph = GLYPHS[k]
            const hot = HOTSPOT[k]
            return (
              <div
                key={k}
                className="ss-cursor__glyph"
                data-glyph={k}
                data-active={k === shown}
                style={{ marginLeft: -hot.x, marginTop: -hot.y, transformOrigin: `${hot.x}px ${hot.y}px` }}
              >
                <Glyph />
              </div>
            )
          })}
      </div>
    </div>
  )
}

/** A ring that spreads from the click point and fades, drawn under the cursor. */
export function ripple(root: HTMLElement, at: Point) {
  const r = document.createElement('span')
  r.className = 'ss-ripple'
  r.style.left = `${at.x}px`
  r.style.top = `${at.y}px`
  root.appendChild(r)
  r.addEventListener('animationend', () => r.remove())
}
