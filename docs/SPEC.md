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

## Ballpark (energy orders-of-magnitude game)
Decided 2026-10-25. A second game at `/ballpark` for an intuition of how much **energy** everyday things take. Launched 2026-10-26 after Gero's play-test: it is a PROJECTS node in the home node menu (between Pac-Man DQN and Networking Tracker), with a `▶ PLAY` badge, the line `11 decades of energy` and a plain link to `/ballpark` (no glyph morph, since it is not a project page). It is a load in the flow, not a source. It is in the sitemap.

### Lessons
1. **Energy = power × time.** A laptop for 8 h beats a kettle for 5 min.
2. **In a sum, the biggest term wins.**
3. **A ladder of landmarks**, about one per decade, to estimate anything new by comparison.

### A run (10 rounds)
- **Each round** shows 1–3 lines, each an item with a count and a duration or amount (`Kettle · 5 min`, `Drive an EV · 30 miles`). Rounds 1–3 have one line (mostly unlearned landmarks), 4–7 have two, 8–10 have three, and round 8 is a **trap** (high power for a short time next to low power for a long time).
- **The guess** goes on a **fixed log scale from 0.1 Wh to 10 GWh**: tap or drag (pointer-down jumps there, then 1:1), or use the keyboard (←/→ 0.05 decade, Shift a decade, Enter). The readout shows the guess and a live equivalence (`≈ 28 phone charges`). Nothing is pre-placed, so there is no anchoring.
- **The reveal** springs the truth marker in, draws the error as an amber bracket and states it as a factor (`×2.4 high`). It shows per-line maths (`1,500 W × 5 min = 125 Wh`), a linear share bar, the power-vs-energy or biggest-term lesson, and the dominant item's fact with its source.
- **The summary** shows the score out of 1000, the geometric-mean factor off, bias (high/low) for under 1 kWh and for 1 kWh and up, and the ladder of landmarks.

### Scoring
`e = |log10(guess / truth)|` decades; `points = round(100 · max(0, 1 − e))`. Tiers: Bullseye ≤ 0.1, Ballpark ≤ 0.31 (anything shown as ×2), Close-ish ≤ 0.6, Off by ~10× ≤ 1, Different planet beyond.

### Memory
- Each item has a **Leitner box** (1–5). A guess within ×2 moves every item in the round up a box; a miss sends the dominant item to box 1. Items are drawn with weight `1 / 2^box`.
- **Landmarks:** 12 anchors (`src/energy/catalog.ts` `ANCHORS`). Guessing one within ×2 twice pins it to the scale as a dot; the one used in the live equivalence glows and shows its label.
- Progress lives in `localStorage` (`ballpark-progress`), wrapped in try/catch.

### Data
US references (120 V homes, gallons, miles). Every item carries a source; the main ones are EIA (home: 10,791 kWh/yr in 2022; per person: 279 MMBtu in 2023), EPA (33.7 kWh per gallon), Epoch AI (0.3 Wh per chat query), Patterson et al. 2021 (GPT-3: 1,287 MWh), DOE-method appliance wattages via Virginia Tech Extension. The flight seat (~30 gal of jet fuel, ~1.1 MWh) is a rough estimate.

## Raup's Cube (shell morphospace)
Decided 2026-10-26. A third interactive at `/shells` that recreates David Raup's theoretical morphology of coiled shells (Raup 1966, *Geometric analysis of shell coiling*). Launched 2026-10-27 as a `▶ PLAY` node in the home menu's PROJECTS section, after Ballpark ("3 numbers shape a shell"), and listed in the sitemap.

### The model
A shell is one circular tube, the generating curve, that grows as it turns around a fixed axis. Three numbers set its form:
- **W, whorl expansion rate:** how much the tube grows per turn (log scale, 1.01 to 10⁶).
- **D, distance from the axis:** inner edge ÷ outer edge of the generating curve (0 to 0.95).
- **T, translation rate:** axial slide per unit of distance from the axis (0 to 4).

Geometry (`src/shells/model.ts`): aperture radius `a = W^(θ/2π)`, centre distance `r_c = a(1+D)/(1−D)`, axial position `z = −T·r_c`, with θ ≤ 0 and the aperture at θ = 0. The tube is drawn back to 1/1000 of the aperture's size, at most 8 whorls, so for W ≥ 10³ it is less than one turn: a clam or brachiopod valve falls out of the same rule.

**Whorls touch** when the generating circle and the one a turn later overlap: `(W−1)·(1+D)/(1−D)·√(1+T²) < W+1`. At T = 0 that is Raup's hyperbola, W·D < 1.

### The page
- **The shell:** a sticky 3D view. On desktop it is the left column; on phones it is pinned under the top bar.
  - WebGL2 surface with cyan growth lines, an amber growing edge and a darker inside.
  - Drag sideways to turn it, with a flick and an idle turn. A mouse can also tilt it.
  - It grows from the tip on load and with "Grow again".
  - "Pair valves" mirrors a valve when W ≥ 30.
  - The Canvas 2D fallback draws the generating circles in painter's order, like Raup's 1962 plots.
- **Controls:** W, D and T sliders. Pointer-down jumps there, then the thumb follows 1:1. Keyboard: arrows move 1% of the track, Shift moves 10%. Each parameter is a `Spring`, with W springing in log space.
- **Six lessons:**
  1. One tube (a nautilus)
  2. W
  3. D (the touch line)
  4. T (a snail)
  5. Push W (a clam, then a brachiopod)
  6. The cube

  Each lesson springs the shell to a target and highlights one control without locking the others.
- **The cube map:**
  - log W across, D up, and a T strip on the right. Drag either to set the shell.
  - The touch boundary for the current T is drawn in amber.
  - Each region is shaded and named while the current T is inside its range, and drawn as a dashed outline otherwise.
  - The regions appear after lesson 6, or with "Show where real shells live".
  - Presets: Nautilus, Ammonite, Spirula, Turritella, Garden snail, Clam, Brachiopod.
  - "Show me a shell that never existed" picks a seeded point outside every region.
- **State:** the URL hash (`#W=2.20&D=0.10&T=1.20`) is written after map, slider and preset changes, and opens the page on the cube. Lesson progress and `cubeSeen` live in `localStorage` (`shells-progress`), wrapped in try/catch.
- **Reduced motion:** there is no loop, growth or idle turn. One frame is drawn per change.

### Regions (approximate)
Boxes in (log10 W, D, T) after the textbook reproductions of Raup's cube; the page says they are approximate:

| Region | log10 W | D | T |
|---|---|---|---|
| Coiled cephalopods | 0.2–0.7 | 0–0.6 | 0–0.15 |
| Snails | 0.05–1 | 0–0.5 | 0.3–4 |
| Brachiopods | 1.5–5.5 | 0–0.1 | 0–0.1 |
| Bivalves | 1–4 | 0–0.5 | 0–0.6 |

**Still to check:** these boxes against Raup's 1966 figure, or against McGhee's *Theoretical Morphology* (1999).

### Identify ("What shell is this?")
- **Catalog** (`src/shells/catalog.ts`): 16 real shells placed in the cube. Each entry has its W, D and T, habitat, what the shell is for, three facts and a credited Wikimedia Commons photo (`src/assets/shells/<id>.jpg`, 900 px wide). Facts were checked against Wikipedia on 2026-10-27. The preset chips are the entries marked `preset`.
- **Matching** (`src/shells/identify.ts`): nearest entry by distance in cube units: Δlog10 W / 0.4, ΔD / 0.12 and ΔT / 0.5. The tiers are:
  - `match` when the distance is ≤ 1.5 ("This is a real shell");
  - `resembles` when it is ≤ 4, or the shell is inside one of Raup's regions ("Closest real shell");
  - `none` otherwise ("No known animal builds this · nearest real shell").

  The next two entries show as "Also close" chips. `Identifier` is the interface a model-based identifier can replace later.
- **Coil chip:** `coilKind` compares the generating circle with the one a turn later:
  - `involute`: the old circle lies inside the new one (a nautilus);
  - `overlapping`: most snails;
  - `loose`: the circles don't touch, which is rare (Spirula, wentletrap). `loose` ⇔ `!whorlsTouch`.

  Nothing is called physically impossible: Raup's geometry never truly passes through itself. Where whorls overlap, the card notes that the animal reuses the old whorl as its inner wall.
- **Card:**
  - All 16 are rendered on the server with lazy `<Image>`, and JS shows the match.
  - It springs in, and dims as "Shell changed: identify again" when the shell moves.
  - "Grow the real one" springs to the entry, and "Read more" links to Wikipedia.
