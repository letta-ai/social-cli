#!/usr/bin/env npx tsx
/**
 * generate-card: Create a branded thread header card.
 *
 * Usage:
 *   npx tsx skills/thread-cards/generate-card.ts \
 *     --title "Thread title here" \
 *     --subtitle "6 sources · April 10, 2026" \
 *     --pattern ripple \
 *     --output /tmp/thread-card.png
 *
 * Patterns: ripple (default), angular, orbital, grid
 */

import { Resvg } from "@resvg/resvg-js"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

// ── Config ──────────────────────────────────────────────────────────
const WIDTH = 1200
const HEIGHT = 628
const BG = "#000000"
const FG = "#ffffff"
const MUTED = "#666666"
const ACCENT = "#999999"

// ── Pattern generators ──────────────────────────────────────────────

/** Concentric circles with descending centers — matches actual avatar geometry */
function patternRipple(): string {
  const cx = 220
  const cy = HEIGHT / 2 - 20
  const elements: string[] = []

  // Outer circle
  elements.push(
    `<circle cx="${cx}" cy="${cy}" r="185" fill="none" stroke="${FG}" stroke-width="16" opacity="0.85" />`
  )
  // Middle circle — shifted down
  elements.push(
    `<circle cx="${cx}" cy="${cy + 52}" r="132" fill="none" stroke="${FG}" stroke-width="14" opacity="0.6" />`
  )
  // Inner circle — shifted further down
  elements.push(
    `<circle cx="${cx}" cy="${cy + 100}" r="84" fill="none" stroke="${FG}" stroke-width="12" opacity="0.4" />`
  )
  // Core dot
  elements.push(
    `<circle cx="${cx}" cy="${cy + 130}" r="22" fill="${FG}" opacity="0.25" />`
  )
  return elements.join("\n    ")
}

/** Intersecting angular arcs — for policy/regulatory threads */
function patternAngular(): string {
  const elements: string[] = []
  const cy = HEIGHT / 2
  // Primary arc cluster from left
  for (let i = 0; i < 4; i++) {
    const r = 160 + i * 100
    const sw = 14 - i * 2
    const opacity = 0.8 - i * 0.15
    elements.push(
      `<path d="M 0 ${cy + 80 - i * 25} A ${r} ${r} 0 0 1 ${r * 0.65} ${cy - 200}" fill="none" stroke="${FG}" stroke-width="${sw}" opacity="${opacity}" />`
    )
  }
  // Secondary cluster from bottom-right
  for (let i = 0; i < 3; i++) {
    const r = 150 + i * 90
    const sw = 10 - i * 2
    const opacity = 0.35 - i * 0.08
    elements.push(
      `<path d="M ${WIDTH - 60} ${cy + 160 + i * 30} A ${r} ${r} 0 0 0 ${WIDTH - r * 0.55 - 60} ${cy - 100}" fill="none" stroke="${FG}" stroke-width="${sw}" opacity="${opacity}" />`
    )
  }
  return elements.join("\n    ")
}

/** Orbital circles — for tech/model threads */
function patternOrbital(): string {
  const elements: string[] = []
  const cx = 210
  const cy = HEIGHT / 2

  // Core circle
  elements.push(
    `<circle cx="${cx}" cy="${cy}" r="28" fill="${FG}" opacity="0.8" />`
  )

  // Orbital rings with varying tilt (simulated via ellipses)
  const orbits = [
    { rx: 90, ry: 70, rotate: -15, sw: 10, opacity: 0.65 },
    { rx: 155, ry: 115, rotate: -20, sw: 8, opacity: 0.45 },
    { rx: 230, ry: 170, rotate: -25, sw: 6, opacity: 0.3 },
    { rx: 310, ry: 220, rotate: -28, sw: 4, opacity: 0.18 },
  ]
  for (const o of orbits) {
    elements.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="${o.rx}" ry="${o.ry}" fill="none" stroke="${FG}" stroke-width="${o.sw}" opacity="${o.opacity}" transform="rotate(${o.rotate} ${cx} ${cy})" />`
    )
  }
  return elements.join("\n    ")
}

/** Dot grid with wave distortion — for data/research threads */
function patternGrid(): string {
  const elements: string[] = []
  const spacing = 40
  const cx = 150
  const cy = HEIGHT / 2

  for (let x = 20; x < WIDTH * 0.45; x += spacing) {
    for (let y = 20; y < HEIGHT - 20; y += spacing) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      const wave = Math.sin(dist / 60) * 8
      const size = Math.max(1.5, 4 - dist / 200)
      const opacity = Math.max(0.1, 0.7 - dist / 500)
      elements.push(
        `<circle cx="${x + wave}" cy="${y + wave * 0.5}" r="${size}" fill="${FG}" opacity="${opacity}" />`
      )
    }
  }
  return elements.join("\n    ")
}

const PATTERNS: Record<string, () => string> = {
  ripple: patternRipple,
  angular: patternAngular,
  orbital: patternOrbital,
  grid: patternGrid,
}

// ── Text wrapping ───────────────────────────────────────────────────

/** Estimate character width for a monospaced-ish layout. Returns wrapped lines. */
function wrapTitle(title: string, maxCharsPerLine: number): string[] {
  const words = title.split(/\s+/)
  const lines: string[] = []
  let current = ""

  for (const word of words) {
    if (current.length + word.length + 1 > maxCharsPerLine && current.length > 0) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 4) // max 4 lines
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

// ── Logo mark (from actual sensemaker.svg — concentric circles with descending centers) ──

function logoMark(x: number, y: number, size: number): string {
  // Original SVG viewBox is ~250x250, logo centered around (105, 175).
  // Scale to fit requested size.
  const s = size / 210
  const ox = x - size / 2
  const oy = y - size / 2
  return `
    <g transform="translate(${ox}, ${oy}) scale(${s})">
      <!-- White fill circle (background for the mark) -->
      <circle cx="105" cy="148" r="100" fill="${FG}" />
      <!-- Middle ring (black stroke creates the band) -->
      <circle cx="105" cy="176" r="71" fill="none" stroke="${BG}" stroke-width="15.5" />
      <!-- Inner ring -->
      <circle cx="105" cy="203" r="46" fill="none" stroke="${BG}" stroke-width="15.5" />
    </g>`
}

// ── SVG assembly ────────────────────────────────────────────────────

function buildSvg(opts: {
  title: string
  subtitle?: string
  pattern: string
}): string {
  const patternFn = PATTERNS[opts.pattern] ?? PATTERNS.ripple
  const titleLines = wrapTitle(opts.title, 14)

  // Title positioning — right side, vertically centered
  // Sized for legibility at ~500px display width in Bluesky timeline
  const titleFontSize = titleLines.some((l) => l.length > 12) ? 80 : 96
  const lineHeight = titleFontSize * 1.25
  const titleBlockHeight = titleLines.length * lineHeight
  const subtitleSpace = opts.subtitle ? 60 : 0
  const totalBlock = titleBlockHeight + subtitleSpace
  const titleStartY = (HEIGHT - totalBlock) / 2 + titleFontSize * 0.85

  const titleElements = titleLines
    .map(
      (line, i) =>
        `<text x="500" y="${titleStartY + i * lineHeight}" font-family="'Inter', 'Helvetica Neue', 'Arial', sans-serif" font-size="${titleFontSize}" font-weight="700" fill="${FG}" letter-spacing="-0.02em">${escapeXml(line)}</text>`
    )
    .join("\n    ")

  const subtitleY = titleStartY + titleLines.length * lineHeight + 20
  const subtitleElement = opts.subtitle
    ? `<text x="500" y="${subtitleY}" font-family="'Inter', 'Helvetica Neue', 'Arial', sans-serif" font-size="42" font-weight="400" fill="${MUTED}">${escapeXml(opts.subtitle)}</text>`
    : ""

  // Logo mark in bottom-right
  const logo = logoMark(WIDTH - 65, HEIGHT - 55, 55)

  // Divider line between pattern and text
  const divider = `<line x1="460" y1="60" x2="460" y2="${HEIGHT - 60}" stroke="${ACCENT}" stroke-width="1" opacity="0.3" />`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}" />

  <!-- Pattern -->
  <g>
    ${patternFn()}
  </g>

  <!-- Divider -->
  ${divider}

  <!-- Title -->
  <g>
    ${titleElements}
  </g>

  <!-- Subtitle -->
  ${subtitleElement}

  <!-- Logo -->
  ${logo}
</svg>`
}

// ── PNG render ───────────────────────────────────────────────────────

function renderPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: WIDTH },
    font: {
      loadSystemFonts: true,
    },
  })
  const pngData = resvg.render()
  return Buffer.from(pngData.asPng())
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(): {
  title: string
  subtitle?: string
  pattern: string
  output: string
} {
  const args = process.argv.slice(2)
  let title = ""
  let subtitle: string | undefined
  let pattern = "ripple"
  let output = "/tmp/thread-card.png"

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--title":
        title = args[++i]
        break
      case "--subtitle":
        subtitle = args[++i]
        break
      case "--pattern":
        pattern = args[++i]
        break
      case "--output":
        output = args[++i]
        break
    }
  }

  if (!title) {
    console.error("Usage: generate-card.ts --title 'Thread title' [--subtitle '...'] [--pattern ripple|angular|orbital|grid] [--output path.png]")
    process.exit(1)
  }

  return { title, subtitle, pattern, output: resolve(process.cwd(), output) }
}

// ── Main ────────────────────────────────────────────────────────────

const opts = parseArgs()
const svg = buildSvg(opts)
const png = renderPng(svg)
writeFileSync(opts.output, png)
console.log(`Card: ${opts.output} (${(png.length / 1024).toFixed(0)} KB)`)
