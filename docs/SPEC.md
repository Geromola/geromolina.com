# geromolina.com — spec

Personal site for Gero (Geronimo Molina, Haas MBA). Fun first: a presentation card and a phone launcher for his live projects. It is not a CV: there's no resume section or PDF. Dark theme only, English only.

## Goals
- The home hero is an interactive **power-grid map** that is also a **puzzle game** ("Grid operator") *and* the site navigation.
- Live projects are reachable on a phone in one tap. The site is an installable PWA.
- Very high craft, following Apple's fluid-interface principles. Concretely:
  - respond on pointer-down
  - springs that animate from the current value (`src/grid/spring.ts`)
  - nothing locks input
  - glass panels
  - reduced-motion and transparency fallbacks
  - system font, with mono only for readouts

## Non-goals
CV/resume, contact form, sound, haptics, light theme, i18n, a CMS, any backend.

## Stack
Astro 7 + TypeScript (TypeScript 6 pinned for `astro check`), Vitest, and a custom WebGL2 renderer with a Canvas 2D fallback. Hosted on Vercel; the domain geromolina.com is on Cloudflare. No UI framework.

## Content
| Node id | Kind | Destination |
|---|---|---|
| custom-llm | plant | `/projects/custom-llm` → live https://geromola.github.io/custom-llm/viz/ (repo Geromola/custom-llm) |
| spotify-insight | plant | `/projects/spotify-insight` → live https://spotify-insight-dashboard-seven.vercel.app (repo Geromola/spotify-insight-pipeline) |
| networking-tracker | substation, locked | opens https://networking-tracker-navy.vercel.app/ directly (Gero's private tool, no detail page) |
| about, off-the-grid, contact | section | `#about`, `#off-the-grid`, `#contact` on the home page |

- Contact: `hi@geromolina.com`, linkedin.com/in/geronimo-molina, github.com/Geromola.
- Photo: `src/assets/gero.jpg`, shown as a round crop with a dark duotone in the site's colours.

## Design tokens
`src/styles/tokens.css`:
- **Colours:** background `#04070b`; cyan `#5fe3ff` for low-voltage and live elements; amber `#ffb547` for heat, locked and warning states; hot white `#eef7ff` for the 345 kV corridors.
- **Glass:** the `.glass` class.
- **Type:** system-ui; `var(--mono)` only for numbers and labels.

## The grid game ("Grid operator")

### Physics (stylised but true)
- The grid is AC, because transformers only work on AC.
- There are two voltage levels:
  - **LOW = 13.8 kV**: generation and distribution
  - **HIGH = 345 kV**: transmission, a ×25 ratio
- **A transformer is a single type, placed on a lattice junction.** Any electron (energy packet) passing through it switches level, LOW↔HIGH, because real transformers work in both directions. Each pass costs `T_LOSS = 1%` of its energy.
- **Line loss per lattice segment follows I²R.** `LOSS_LOW = 6%`, and `LOSS_HIGH = LOSS_LOW / 625`, because the current is 25× lower and loss scales with I².
- **Delivery.** Energy delivered to a load node at LOW counts. Arriving at HIGH is an overvoltage: the electron sparks and is not delivered.
- **A load is lit** when its expected efficiency is ≥ `LIT_THRESHOLD = 0.8`.
- Plants emit at LOW.
- **Drift speed** follows current, so HIGH electrons drift slower (×0.5, stylised).
- **Brightness and colour:**
  - Brightness ∝ remaining energy.
  - HIGH electrons are white-hot; LOW electrons are cyan.
  - Electrons shift toward dim amber as their energy runs out.
- These constants are starting values. Tuning is allowed if the level tests below require it; report any change.

### Routing ("power finds the cheapest path")
- **State graph.** Each lattice vertex exists at both levels, written `(vertex, level)`.
  - Moving along a segment costs `-ln(1-LOSS_level)`.
  - Entering a transformer vertex flips the level and adds `-ln(1-T_LOSS)`.
  - Faulted edges are removed.
- **Per-load cost table.** For each active load, run a backward Dijkstra from `(load, LOW)` to get `cost_L(vertex, level)`. Recompute whenever transformers or faults change (it's cheap).
- **Load efficiency.** A load's efficiency = `max over active plants P of exp(-cost_L(P, LOW))`.
- **Level efficiency** = mean of load efficiencies (equal demand).
- **Electron movement.** At each junction an electron picks its next edge by softmax over `edgeCost + cost_L(next, level')`, with temperature ≈ 0.15 nats. This keeps the motion organic while staying near the cheapest path.
  - Avoid immediate reversal.
  - Electrons whose target is unreachable wander and die.
- **Spawning.** Electrons spawn at the active plants. Assign their target loads round-robin, and each load is served by its best plant.
- **Ambient electrons.** About 35% of the pool are dim wanderers, which are never counted.
- **Heat.** Keep a per-edge `heat` accumulator: energy lost on that edge, decaying exponentially (τ ≈ 1 s). The renderers draw it as an amber glow on the conductor.

### Levels
The map, node positions and links are the same in every level. A level only changes the active plants, the target loads, the budget (≤ 4) and the faults.

| # | Title | Plants | Loads | Budget | Faults |
|---|---|---|---|---|---|
| 1 | First light | custom-llm | about | 2 | none |
| 2 | Two towns | custom-llm | about, off-the-grid | 3 | none |
| 3 | Long haul | spotify-insight | contact, about | 4 | none |
| 4 | Storm damage | both | about, contact, networking-tracker | 4 | ~12% of edges cut (seeded, never next to a node, regenerated until solvable) |

- **Placement.** Transformers can't go on node vertices. Every other junction in the visible area is valid.
- **Win.** All target loads are lit.
- **Stars.** The solver computes the best achievable efficiency for the current layout. Then:
  - ★ = win
  - ★★ = efficiency ≥ 0.93 × best
  - ★★★ = efficiency ≥ 0.985 × best
- **Solver.** Candidates are the non-node vertices within Manhattan distance 1 of active plants and loads. Use greedy search plus 1-swap local search, capped at about 30 ms in the browser.
- **Testable requirements.** Each must hold on the reference layouts 1440×900, 800×600 and 390×844 (portrait):
  - the solver's layout lights every load within budget;
  - **no transformers does not** win (otherwise the puzzle is trivial).
- **Progress.** Unlocked levels and best stars are saved in `localStorage`, wrapped in try/catch so the page works without it.

### Interaction
- **Ghost preview.** With a fine pointer, a ghost transformer (40% opacity) snaps to the nearest valid junction within 0.45 × spacing.
- **Place.** Click or tap a junction. Placement happens on pointer-down, instantly.
- **Remove.** Click or tap a placed transformer. It springs out.
- **Move.** Drag a placed transformer: there's a 10px threshold, then pointer capture, and it tracks 1:1 with the grab offset kept. Snap on drop. An invalid drop springs back to where it started.
- **Out of budget.** Clicking a junction with no transformers left makes the budget dots shake with a spring, and shows a fun fact once.
- **Placed transformer markup.** A DOM `<button>` at the vertex with a two-coil glyph, labelled e.g. "Transformer, click to remove".
- **Node links always work.** Nodes that aren't part of the current level are dimmed (opacity 0.55) but stay clickable.
- **Phones.** `touch-action: pan-y` on the map, so vertical swipes scroll the page and taps place transformers.

### Level panel
The level panel replaces the old meter.
- **Desktop:** bottom-left glass panel about 18.5rem wide, containing:
  - `LEVEL n / 4` in mono, plus the level title
  - a one-line objective
  - budget dots
  - **Efficiency %** (large, mono), **Delivered MW** and **Lost as heat MW**, with plant output 50 MW per active plant
  - load chips showing each target node's title and lit state
  - Reset and Next buttons (Next is enabled after a win), and level dots for unlocked levels
- **Phones:** a chip reading `Lv 2 · ●●○○ · 86%` that expands when tapped.
- **On a win:**
  - the lit loads pulse
  - stars scale in on a damping-1 spring
  - a toast says "Level cleared ★★☆"

### Fun-fact toasts
Each shows once per session.
- **Level 1 intro, after 2 s idle:** the objective, plus "Transformers only work on AC — that's why the grid is AC."
- **First placement:** "345 kV means 25× less current, so 625× less heat (I²R)."
- **First visible heat:** "That amber glow is I²R loss."
- **First lit node.**
- **Out of budget.**

### Reduced motion
No animation loop. Redraw a static steady-state frame after every change; the panel still works.

## Pages (later tasks)
- `/`: the hero map, then About (photo + playful bio), Off the grid (Muay Thai title, the cycling team he founded, Haas MBA, the ACS solar electrolysis paper), My tools (the locked networking-tracker tile), Contact, and an accessible list of every node.
- `/projects/[slug]` for plant nodes:
  - a two-line pitch
  - a lazy-loaded sandboxed iframe of the live app, with a "Launch full-screen" button; if framing is blocked, a screenshot plus the button
  - three metric chips
  - "How it works"
  - a GitHub link
- `404`: "Power outage".
- **Transitions:** clicking a node charges it on pointer-down, then a view transition expands the page out of the node; going back collapses it into the same node.
- PWA manifest and service worker, sitemap, OG image, Vercel Web Analytics (no cookies).

## Definition of done (MVP)
- The verification list in `docs/PLAN.md` passes.
- Lighthouse on mobile: Performance ≥ 90, Accessibility ≥ 95.
- Deployed to geromolina.com.


## Home hero v2: projects first (supersedes "the map is the navigation")
Decided 2026-10-25 after Gero's review: the first thing a visitor sees is a **profile with a menu of projects at the centre**. The grid is decoration behind it. The game is an opt-in secondary mode.

### Projects mode (default on load)
- **Background:** the grid canvas stays full-bleed behind everything, running ambient electrons only.
  - There is no level panel, toast, ghost or click-to-place.
  - Electrons flow between the project cards' anchor points along the conductors. Hovering or focusing a card pulls the flow toward that card's anchor. The heat layer is off.
- **Profile header**, centred:
  - a 72px round duotone portrait (same treatment as About, cyan ring)
  - the mono kicker `GERONIMO MOLINA`
  - the name `Gero` at `clamp(3rem, 7vw, 5.5rem)`
  - the line `MBA + MEng Candidate · UC Berkeley, California`
- **Section nav**, top right: a glass pill with About · Off the grid · Contact · a lock icon for My tools (linking to `#my-tools`). On phones it's a compact row.
- **Project menu**, centred under the header:
  - a responsive grid of glass cards: 2 columns on desktop, 1 column on phones, max width 60rem
  - the order is Custom LLM, Spotify Insight, Personal Wiki, Pac-Man DQN, then Networking Tracker as a smaller full-width locked strip
- **Each card:**
  - a status badge: `● LIVE` (cyan), `‹/› CODE` (muted), or `🔒 MINE` (amber)
  - the title, a one-line pitch (two lines max), and one key metric in mono cyan
  - `Open →`
  - Each card's top edge has a small terminal dot snapped to the nearest lattice vertex. That vertex is the card's anchor in the decorative flow, so cards look wired into the grid.
- **Card interaction:**
  - Hover lifts the card by 2px and brightens its border.
  - Pointer-down scales it to 0.98 and charges its badge dot.
  - A click opens the project page, which expands out of the card's dot (the view transition re-anchored from map node to card).
- **Play entry:** under the cards, a secondary pill `▶ Play the grid`, small and muted.

### Play mode
- Pressing **Play** springs the cards and the header out (opacity and scale, damping 1) and fades the existing game map in: the node glyphs, the level panel and the level 1 intro. These are today's game, unchanged.
- A `✕ Back to projects` pill sits at top centre and reverses the change.
- The mode is in the URL hash (`#play`), so it is linkable and the back button works. Progress keeps persisting as it does today.

### Nodes in the content collection
- New field `status: 'live' | 'code' | 'private'`.
- New field `inGame` (boolean, default true). The game map uses only `inGame` nodes; the two new code projects are `inGame: false`, so the game levels and tests are unchanged.
- Code projects get `/projects/<slug>` pages the same way as live ones, but without an embed. They show the repo as the primary call to action.
