# Claude Rabbit — DESIGN.md

> The baseline visual specification for Claude Rabbit.
> Open source ships malware, too. We run the code in a disposable sandbox and show exactly what it does.
>
> The single source of truth for the product UI and the on-the-fly report renderer. Every
> generated `/owner/repo` report is fed this spec so it reads as a member of the same family.
> If a decision can't be derived from this document, it doesn't ship.

---

## 1. Principles

1. **Curated and warm, not generic.** A warm off-white "stone" canvas with a refined serif display face and a precise sans. Light is the default; the product should read like a well-set magazine, calm and expensive.
2. **Dual-mode, parity-first.** Light and dark are both first-class, switched by a visible toggle (never the system theme). Every token has a light and dark value tuned for equal contrast and hierarchy.
3. **Restraint with one luxury.** Near-monochrome surfaces; the only saturated color is functional (the score). The luxury is space, type, and material, not ornament.
4. **Material, used sparingly.** Apple-style frosted glass and soft depth on the surfaces that float (the floating sidebar pill, nav, scan bar, toasts, overlays). Elsewhere, depth is hairlines and faint fills.
5. **Honest by construction.** No surface states a bare "Safe." The verdict shows evidence and names what was not verified.
6. **Reputation and behavior stay separable.** Owner/reputation signals are always visually and structurally distinct from code/behavior signals.
7. **Motion conveys state.** One easing vocabulary, one global loader, durations that stay out of the way.

---

## 2. Typography

Two free, public families. This is a deliberate display/text pairing (serif + sans) for editorial contrast.

- **Instrument Serif** (400, 400 italic) — all display: hero headlines, section titles, screen titles, and **every hero number** (the report score, leaderboard ranks and scores, large stat figures). The score is the hero of a report; rendered in serif at large size with a soft colored glow, it reads as exquisite, not as terminal output. Italics carry the second line of the hero headline.
- **Geist** (300–700) — all text UI: body, labels, buttons, captions, table cells, logs, and small inline data. There is **no monospace anywhere.** Numbers that must align (logs, stat columns, limits) use `font-variant-numeric: tabular-nums` via the `.tnum` utility. Logs are a reading surface set in Geist, not a code editor.

Type scale (deliberate, high-contrast):

| Role | Family / weight | Size | Notes |
|---|---|---|---|
| Hero display | Instrument Serif 400 | `clamp(46px,7.4vw,86px)` | line-height 0.98, `-0.018em`, 2nd line italic |
| Section title | Instrument Serif 400 | `clamp(32px,4.4vw,46px)` | line-height 1 |
| Screen title | Instrument Serif 400 | 40px | dashboard/profile/login |
| Hero score | Instrument Serif 400 | 62px (report), 92px (board #1) | colored text-shadow glow |
| Stat / rank figure | Instrument Serif 400 | 18–34px | tabular |
| Body lead | Geist 400 | 16–19px | line-height 1.6–1.65, color `--t3` |
| Body | Geist 400/450 | 13.5–15px | line-height 1.5–1.6 |
| Eyebrow label | Geist 500 | 10.5–11px | `letter-spacing 0.16–0.22em`, uppercase, `--t4` |
| Caption / meta | Geist 400 | 11.5–13px | `--t4` / `--t5` |

Body copy caps near 65ch. Hierarchy comes from the serif/sans split and weight/color contrast first, scale second. `text-wrap: balance` on display headings, `pretty` on prose. In dark mode, body sits at `--t2/--t3` (never pure white) with a hair of letter-spacing for the standard light-on-dark weight compensation.on: body sits at `--t2/--t3` (never pure white) with a hair of letter-spacing on the body default.

---

## 3. Color & theme

The design reference is a warm-stone editorial system (tasteskill.dev): off-white paper, warm-tinted neutrals, deep functional accents. Every color is a CSS variable defined twice, once on `:root` (light, the default) and once on `[data-theme="dark"]` (warm charcoal). The root element carries `data-theme`; a toggle in the nav and the sidebar flips it. The app **defaults to light** and never follows the OS theme.

### Light (default) — warm stone

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f3f1ec` | Canvas |
| `--bg2` | `#e9e5dd` | Ambient depth |
| `--paper` | `#fbfaf7` | Inputs, raised fields |
| `--s1/--s2/--s3` | `rgba(40,34,24, .028 / .055 / .085)` | Card fill → hover → active |
| `--glass` | `rgba(251,250,247,0.72)` + blur | Floating sidebar, nav, toast, overlays |
| `--line/2/3` | `rgba(40,34,24, .10 / .16 / .28)` | Hairline → strong border |
| `--t1 … --t6` | `#221f1a · #403a32 · #6d665b · #928a7d · #b0a797 · #cdc5b6` | Warm-ink text ramp |
| `--ink / --ink-fg` | `#221f1a / #f7f5f0` | Primary button (dark on light) |

### Dark — warm charcoal (counterpart)

`--bg #16130f`, `--paper #1d1916`, neutrals `rgba(255,255,255,…)`, text ramp `#f4f1ea → #39322a`, `--ink #f4f1ea / --ink-fg #1a1714`. Shadows deepen; grain rises to 0.5 (overlay) vs 0.04 (multiply) in light.

### Functional score palette (theme-aware)

Each band is a var pair `--band` + `--band-g` (glow) + `--band-t` (tint). Light values are deepened so they read on stone; dark values brighten. Logic returns `var(--green)` etc. so a score recolors automatically per theme.

| Band | Range | Light | Dark | Verdict |
|---|---|---|---|---|
| **Green** | `≥ 90` | `oklch(0.56 0.13 154)` | `oklch(0.80 0.14 158)` | High trust |
| **Blue** | `80–89` | `oklch(0.54 0.12 248)` | `oklch(0.74 0.11 232)` | Likely safe |
| **Amber** | `60–79` | `oklch(0.66 0.13 62)` | `oklch(0.83 0.13 80)` | Caution |
| **Red** | `< 60` | `oklch(0.55 0.19 27)` | `oklch(0.66 0.20 25)` | Dangerous |

```
band(score) = score>=90 ? green : score>=80 ? blue : score>=60 ? amber : red
```

**Gold** (`--gold`, `oklch(0.68 0.13 76)` light / `0.84 0.15 86` dark) is reserved for GitHub stars, never grey. Severity maps to band hues; reputation flags reuse them but are always labelled.

---

## 4. Material, depth, spacing

- **Glass, only where it floats:** sticky nav, the scan bar, toasts, the logs overlay header, and the leaderboard sub-nav use `--glass` + backdrop blur + `inset 0 1px 0 rgba(255,255,255,0.04)` edge highlight. Nothing else uses glass.
- **Soft depth:** floating elements take wide, low tinted shadows (`0 18px 50px rgba(0,0,0,0.5)` on the scan bar; `0 24px 60px` on board/cards). Most cards have no shadow, only a hairline and a faint fill.
- **Film grain:** a single fixed, `pointer-events:none` noise layer, theme-aware (`multiply` at ~0.04 in light, `overlay` at ~0.5 in dark, tweakable off). Adds tooth so a flat field never reads as dead.
- **Ambient glow:** a barely-there multi-stop radial wash behind the home hero (a soft paper bloom + faint green and red band tints) and login (tweakable off). Premium, not a lava-lamp.
- **Spacing scale (px):** 4 · 6 · 8 · 11 · 14 · 18 · 22 · 26 · 32 · 44 · 52 · 72 · 90 · 130 · 140. Section rhythm on the homepage steps up (90 → 130 → 140) for breathing room.
- **Radius:** inputs/buttons `11–18px`; cards/panels `16–24px`; pills `100px`; score tiles `9–12px`. Larger containers, larger radii.
- **Borders over boxes; never a card inside a card.** Group with hairlines and grid gaps before reaching for a panel.

---

## 5. The global loader

One loader, everywhere there is a wait — processing header, ad background work, transitions.

- **Form:** a 3×3 grid of small rounded squares (5–7px, 4–5px gap), scaled as one unit, in `--t1` so it inverts per theme.
- **Motion:** each dot runs `rabbitDot` — `opacity .16→1`, `scale .66→1` over `1.5s ease-in-out infinite`, delays cascading by diagonal distance (`0 / 90 / 180 / 270 / 360ms`) so a soft wave crosses the grid.
- **Rule:** if something is pending, this loader represents it. The only paired variant is the thin ring spinner on the active node of the processing timeline.

```css
@keyframes rabbitDot{ 0%,100%{opacity:.16; transform:scale(.66)} 42%{opacity:1; transform:scale(1)} }
```

---

## 6. Motion

Strong custom ease-out, never `ease-in`; only `transform`/`opacity`/`filter` animated.

| Token | Curve | Use |
|---|---|---|
| `--ease` | `cubic-bezier(0.23,1,0.32,1)` | enters, hovers, rings, bars |
| `--easeio` | `cubic-bezier(0.77,0,0.175,1)` | on-screen movement |
| `--drawer` | `cubic-bezier(0.32,0.72,0,1)` | logs overlay |

| Element | Duration |
|---|---|
| Button press (`scale 0.96–0.98`) | 140ms |
| Hover / color | 160–250ms |
| Screen transition (`screenIn`: fade + 10px rise + blur-out) | 400–500ms |
| Hero / card rise (`riseIn`) | 500–800ms |
| Score ring draw | 1100ms |
| Logs overlay (`drawerIn`) | 400ms |

Named keyframes: `screenIn`, `fadeIn`, `riseIn`, `ringDraw`, `barGrow`, `spinSlow`, `pulseRing` (live halo), `logIn` (log line stagger), `floatY` (scroll cue + ambient), `scoreGlow` (ring halo breathe), `drawerIn`, `shimmer`. **Scroll reveals:** below-fold home sections use a `.reveal` → `.show` IntersectionObserver (one-shot, with a fallback timer), 24px rise + fade on `--ease`. Every pressable element scales on `:active`; cards and rows lift `translateY(-1 to -3px)` on hover. `prefers-reduced-motion` drops transforms and freezes loops.

---

## 7. Components

**Buttons.** Primary: `--t1` fill / `#0a0a0a` text, lit top edge, hover `translateY(-1px)`, active `scale(0.96)`. Secondary: `--s1/--s2` glass-ish fill, hairline border brightening on hover. Destructive (sign out): red-tinted hairline + red text on faint red hover.

**Scan bar.** The dominant home element: a frosted gradient panel (`blur(20px)`), hairline brightening to `--line3` on focus with a 5px faint outer glow, GitHub glyph left, inverted Scan button right. Suggestion chips below: glass pills with a glowing score dot + repo path.

**Score ring.** SVG `r=52`, 6px stroke, faint track, arc in the band color with a `drop-shadow` glow and a breathing radial halo behind it; drawn via `ringDraw`. Centered serif numeral + "OUT OF 100". The canonical score expression.

**Signal panels.** Two equal panels distinguished only by header label + icon: a star glyph for *Reputation signals*, code-brackets for *Code & behavior signals*. Enforces the reputation/behavior separation rule.

**Risky-item card.** Hairline card on a darker inset; glowing severity dot + title; two micro-tags (severity band color, then kind: Behavior / Code / Reputation); detail body. Clean state shows a green check and an honest sentence, never "Safe."

**Leaderboard.** A centerpiece, not a list: a worst-offender hero card (92px serif score, giant ghost "1", band-tinted) above a ranked table (serif rank + band-bordered score tile + repo + reason + band pill + chevron, rows that nudge-right on hover), closed by a four-band legend.

**Sidebar (app shell).** A floating, collapsible rounded-rectangle **pill**, inset from the window edges with frosted glass, a hairline, and a soft shadow, not edge-to-edge. Expanded (264px): wordmark + collapse chevron, New scan + Danger board nav, a one-line impact stat, a scrollable **scan history grouped by time** (Today / Earlier) where each row is a glowing score dot + repo path + score and opens its report, then a profile chip (gradient avatar, name, email) beside a theme toggle. Collapsed (72px): an icon rail, logo, scan, danger, theme, and avatar, each a 44px target with a title tooltip and an expand control. Width animates on the drawer curve.

**Toast.** Centered bottom glass pill with a glowing status dot (score-colored when reporting a verdict), short text, `riseIn`, auto-dismiss ~3.4s. Fires on scan start, login, copy, cached hits, errors, profile save, sign out.

**Logs.** Full-screen overlay (`drawerIn`), a centered reading column: an eyebrow, the summary set large in serif, then chapters (glowing band dot + title with a hairline rail of `›`-prefixed Geist lines). A working "Back to report" button and an X, both closing the overlay.

**Iconography.** Thin line icons, `stroke-width 1.2–1.7`, `currentColor`, 13–18px. Brand glyph: a minimal geometric rabbit (two ear strokes, head circle, eye). No illustrative SVG; imagery uses a striped "Ad slot" placeholder set in serif.

---

## 8. Layout

- Centered single column; max widths ~660px (scan), 680px (processing/dashboard), 720px (logs), 880px (report), 920px (board), 1040px (home sections). Generous vertical rhythm.
- Sticky blurred nav/sub-nav at `z-40`; logs overlay `z-80`; toast `z-90`; grain `z-60`.
- Dashboard is an app shell: fixed 276px sidebar + scrolling content.
- Group rows with flex/grid + `gap`, never inline flow or per-element margins.

---

## 9. Voice & content

- Plain, exact, magnetic. Lead with the tension ("Open source ships malware, too."), keep the honest "we run it" wedge, cut filler. No "seamless / elevate / next-gen." No em dashes.
- Verdicts are honest sentences plus a one-word label (Trusted / Likely safe / Caution / High risk / Malicious) and the score; never false certainty, always a "what we could not verify" list.
- Numbers are believable and messy; repo/owner names invented; no real person named as malicious.

---

## 10. Score-color logic (normative)

```
green  oklch(0.80 0.14 158)   score >= 90    High trust / secure
blue   oklch(0.74 0.11 232)   80–89          Likely safe
amber  oklch(0.83 0.13 80)    60–79          Caution
red    oklch(0.645 0.205 23)  < 60           Dangerous
gold   oklch(0.84 0.15 86)    —              GitHub stars only
```

Applied identically to: report score ring + verdict pill, per-package scores, risky-item severity, leaderboard hero + tiles + band pills, dashboard history, sidebar history dots, homepage activity feed, and the community-sentiment bar.

---

## 11. Tweaks (host props) & theme

Standalone controls, kept small and tasteful:

- `heroHeadline` / `heroHeadlineB` (text) — the two-line hero display copy.
- `heroSub` (text) — the hero subhead.
- `filmGrain` (boolean) — the global grain overlay.
- `ambientGlow` (boolean) — the home/login radial wash.

Theme is runtime state (default light) with a visible toggle in the nav and sidebar, not a tweak. Copy and single colors are editable in place, so they are not duplicated as tweaks.

---

## 12. Screen inventory

Home · Ad · Processing · Report · Danger board · Login · Dashboard · Profile, plus the full-screen Logs overlay.
Cross-cutting behaviors honored everywhere: scan-then-resolve processing, instant cached returns, never-a-bare-Safe, reputation/behavior separation, failed-with-retry, the one global loader, and the one score-color logic.
