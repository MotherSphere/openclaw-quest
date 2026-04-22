import { useEffect, useRef } from 'react'

/**
 * Animated pixel art background — uses direct DOM manipulation to avoid
 * React re-render flicker. Preloads all frames, then swaps src directly.
 *
 * The initial src is the first animation frame itself (not a separate
 * fallback file). The animation frames are versioned in the repo, whereas
 * the decorative `/bg/*-bg.png` fallbacks are gitignored — so using the
 * frame avoids a guaranteed 404 on the first render that used to leave the
 * tavern background black.
 */
export default function AnimatedBg({
  prefix,
  fallback,
  frames = 3,
  fps = 3,
  style,
}: {
  prefix: string
  fallback: string
  frames?: number
  fps?: number
  style?: React.CSSProperties
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const firstFrame = `/bg/anim/${prefix}-f1.png`

  useEffect(() => {
    const srcs: string[] = []
    let loaded = 0
    let frame = 0
    let timer: ReturnType<typeof setInterval>
    let unmounted = false

    let failed = false

    for (let i = 1; i <= frames; i++) {
      const src = `/bg/anim/${prefix}-f${i}.png`
      srcs.push(src)
      const img = new Image()
      img.onload = () => {
        loaded++
        if (!unmounted && !failed && loaded === frames && imgRef.current) {
          imgRef.current.src = srcs[0]
          timer = setInterval(() => {
            frame = (frame + 1) % frames
            if (imgRef.current) {
              imgRef.current.src = srcs[frame]
            }
          }, 1000 / fps)
        }
      }
      img.onerror = () => {
        // If any frame fails, stay on fallback — don't start animation
        failed = true
      }
      img.src = src
    }

    return () => { unmounted = true; clearInterval(timer) }
  }, [prefix, frames, fps])

  return (
    <img
      ref={imgRef}
      src={firstFrame}
      alt=""
      draggable={false}
      onError={(e) => {
        // Graceful degradation: frame 1 -> fallback -> hidden.
        const img = e.target as HTMLImageElement
        if (img.src.endsWith(firstFrame)) {
          img.src = fallback
        } else {
          img.style.visibility = 'hidden'
        }
      }}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'fill',
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  )
}
