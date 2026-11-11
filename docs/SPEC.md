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



## Home hero v3: the node menu (supersedes v2's card grid)
Decided 2026-10-25 after Gero's review of v2. He loves the game's animation (nodes lighting up, electricity flowing between them) and wants it to *be* the menu: legible, navigable, ordered by importance. The transformer game is **parked**: no Play pill and no placing. The code stays, but there is no entry point.

### Layout
- The profile header (portrait, kicker, "Gero", the Berkeley line) and the section nav stay as in v2.
- Below the header, the projects are **grid nodes arranged as an ordered menu**, snapped to lattice vertices in tidy rows, with the most important at the top. Order, from `order` in the collection:
  1. **Featured row:** Spotify Insight, then Custom LLM. Large plant nodes.
  2. **Second row:** Personal Wiki, then Pac-Man DQN. Medium nodes.
  3. **Third row:** Networking Tracker (locked, amber), About, Off the grid and Contact. Small nodes.
- **Leave real space between nodes**, so the conductors and the flowing electrons stay visible. This is a map, not a wall of boxes.
- **Phones:** one column. The nodes sit along a vertical "spine" conductor, with their plates to the right of the glyph. The flow runs down the spine and branches into each node.

### The node object (tangible)
Each node is a **glyph plus a plate**, fused into one link:
- **Glyph:** the existing plant, substation or section ring, scaled per row: 56, 40 and 20px.
- **Plate:** a glass plate attached to the glyph.
  - On desktop it hangs under the glyph, centred, with the glyph overlapping its top edge.
  - On phones it sits to the right of the glyph.
- **Plate content:**
  - **Featured:** badge (`● LIVE` / `‹/› CODE` / `🔒 MINE`), title, a 2-line pitch and one mono metric. About 17–19rem wide.
  - **Second row:** badge, title and a 1-line pitch. About 15rem.
  - **Small:** title only, a compact pill.
- **States:**
  - **Rest:** lit.
  - **Hover or focus:**
    - the plate lifts 2px on a spring and its border brightens
    - the glyph pulses and the ring brightens
    - the flow surges toward that node (the engine's focus share)
    - its corridor brightens
  - **Pointer-down:** the charge sweep, plus scale 0.98.
  - **Click:** opens the page, using the existing view transition from the glyph.

### Flow and power-on
- **Flow:** electrons run from the plant nodes to every other node along **lit corridors**. These look like a solved game board: white-hot 345 kV paths between nodes and cyan where they branch into a node. Transformer glyphs are hidden. Faults, heat glow and the level panel are all off.
- **Power-on intro**, on load:
  - Nodes start dark. The featured plants ignite first, with the charge sweep.
  - Corridors then light progressively outward, and each node's ring fills and lights as power reaches it, staggered by distance. The whole intro takes about 1.2–1.6 s.
  - Under reduced motion everything is lit at once, as a still frame.
- **Ambient:** after the intro, the flow keeps running quietly. The whole map stays calm enough to read.

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
- **Title:** "Every shell in the world in three numbers: Raup's Cube". The home menu node is "Raup's Cube", with the line "3 numbers, every shell".
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
- **The cube:** two views behind a "Cube · Slice" switch.
  - **Cube (default):** a 3D box with log W across, D deep and T up (`src/shells/cube-view.ts`, Canvas 2D).
    - Dragging turns it; on touch, only sideways drags do, so the page still scrolls. It turns slowly on its own while the pointer is away.
    - The regions are translucent boxes, named in a legend underneath.
    - The 16 catalog shells are dots: tap one to grow it and open its card.
    - The amber sheet is where whorls stop touching.
    - The current shell is a glowing point with dashed lines dropped to the floor.
  - **Slice:** the flat map, with log W across, D up and a T strip on the right. Drag either to set the shell.
    - The touch boundary for the current T is drawn in amber.
    - Each region is shaded and named while the current T is inside its range, and drawn as a dashed outline otherwise.
  - The regions and dots appear after lesson 6, or with "Show where real shells live".
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

## Conway's Life
Decided 2026-10-27. A fourth interactive at `/life`: Conway's Game of Life (B3/S23), built to show why it matters, not just to run it. It is a `▶ PLAY` node in the home menu's PROJECTS section, after Raup's Cube ("1 rule, a whole universe"), and it is in the sitemap. The skin is the site's own (`tokens.css`).

### The board
- 1024 × 1024 cells (`src/life/engine.ts`). Each row keeps the span of its live cells, so a step only scans those spans: a long diagonal stream costs its length, not its bounding box.
- **Absorbing border:** an object that touches the 4-cell band at the edge is erased whole (live cells chained within two cells). Gliders and gun streams leave cleanly, with no wrap-round and no clipped debris. The page says so in one line.
- **Look:** live cells are round cyan dots with a soft glow from their neighbours. Births by the rule flash `--hot` and cool to cyan over three generations; deaths leave an amber trail for six. Cells placed by hand or by a scene start cyan. Faint grid lines fade in when zoomed in. Zoomed out (under 5 px per cell) cells are flat.
- WebGL2 renderer with a Canvas 2D fallback (`?renderer=canvas`).

### Interaction
- **Draw:** pointer-down toggles a cell at once and a drag paints with the state the first cell took, while running too. A second finger turns the stroke into a pinch and takes the stroke back.
- **Move:** the Move tool, a middle or right drag, two-finger scroll, or a pinch. Zoom with the wheel or a pinch, round the pointer. Gestures follow 1:1; fitting a scene and keyboard zoom spring.
- **Stamp:** from a library card. A ghost follows the pointer; R rotates, F flips, Escape stops.
- **Keyboard:** on the board, arrows move a cursor, Enter toggles a cell (or places the stamp), Shift + arrows pan, + and − zoom. Anywhere: Space plays or pauses, `.` steps, ⌘/Ctrl-Z undoes.
- **Dock:** play/pause, step, speed (1, 2, 4, 8, 15, 30 and 60 per second, or Max at 9 ms of stepping per frame), Draw/Move, "Next gen", Soup (a 64 × 64 square at 37% density), Undo (40 steps), Clear.
- **Next gen:** while paused, births are drawn as white rings and deaths as amber rings. Hovering a cell when paused shows its neighbour count and fate, and lights the matching line of the B3/S23 card.
- **Readout:** generation, population, a 240-generation population chart and a status from `src/life/detect.ts`. Statuses: Ready, Empty, Still life, Oscillator · pN, Spaceship · c/N, Steady stream · pN (a gun feeding the border) and Evolving. Each generation is hashed by shape and by place; periods up to 120 are found.

### Tour (seven steps)
1. One rule: the R-pentomino, paused, with Next gen on.
2. Things that stay: a garden of still lifes and oscillators.
3. Things that move: a glider and the three c/2 spaceships.
4. Chaos from five cells: the R-pentomino and its chart.
5. Machines that make machines: the Gosper gun.
6. Gliders as messages: two guns.
7. Life computes: the message scene.

### Library
Still lifes, oscillators, spaceships (with Copperhead, 2016), methuselahs (R-pentomino 1103, Diehard 130, Acorn 5206) and infinite growth (Gosper and Simkin guns, a puffer train, Callahan's ten-cell seed). Every card has a server-drawn thumbnail, who found it and when, and one line on why it matters. Every period, speed and lifespan the cards state is checked in `tests/life.test.ts`; Acorn's 5206 is quoted from LifeWiki because a 1024 board absorbs its gliders. Sir Robin was planned but left out: LifeWiki's pattern files sit behind a bot check.

### Signals
1. A glider is a bit.
2. A gun is a clock.
3. An eater is a receiver.
4. Two guns talk: they cancel stream for stream.
5. A collision is logic: a NOT gate, with a live truth table.
6. Send a message: up to four printable ASCII characters, 8 bits each. Lamps light as bits arrive, and the characters are decoded.

After those, "Where this goes" cards link to LifeWiki: the Snark, Rendell's Turing machine, Gemini and the OTCA metapixel.

**Construction** (`src/life/scenes.ts`):
- Gun B is a mirrored Gosper gun at (64, 13) from gun A. Found by search, at that offset every B glider meets an A glider at the crossing and both vanish.
- To send data, B sits K × (15, −15) further up its line (a whole number of periods later), both guns run 60K generations, then B is removed. The eraser in its train is deleted wherever the output bit should be 1.
- Clock gliders already past the receiver are dropped. An Eater 1 at (98, 84) eats the output, and a 2 × 2 window at (86, 72) reads it: bit j arrives at generation 215 + 30j.
- The simulation is real; only the lamps are an overlay.

### State
- The URL hash holds `#p=<id>` for a library pattern or a scene, `#msg=<text>` for a message, or `#rle=<pattern>` after an edit, up to 3,000 cells.
- Tour progress lives in `localStorage` (`life-progress`), wrapped in try/catch.
- **Reduced motion:** no autoplay, no birth flash and no trails. The camera and the sheet snap. Play and Step still work.

### Layout
- **Desktop:** the board fills the window under the top bar. The readout is top-left, the dock bottom-centre and the glass panel (Tour / Library / Signals) on the right.
- **Phones:** the panel is a bottom sheet with peek, half and full stops, dragged 1:1 and released on a `Spring` with flick projection. The dock sits above the peek in two rows.

## Projects menu by category
Decided 2026-10-27. The site is also Gero's calling card: a visitor should see in seconds what kind of work each project is. PROJECTS in the home node menu (v3.2) is now grouped into three fixed categories. A category says **what a project is and what a visitor does with it**, never where it came from. There is no "class projects" or "coursework" group; an origin (e.g. Berkeley) is only a small tag on the card.

| id | Label | Tagline |
|---|---|---|
| `math-nature` | Math & Nature | Simple rules, living patterns. |
| `games` | Games | Playable, with something to learn. |
| `solutions` | Solutions | Systems that automate, organize or analyze real work. |

- **Math & Nature:** Conway's Life (`/life`), Raup's Cube (`/shells`).
- **Games:** Pac-Man DQN, Ballpark (`/ballpark`).
- **Solutions:** Spotify Insight, Custom LLM, Personal Wiki, Networking Tracker (still the locked, amber node).

### Data model
- One source of truth: every project and game is a file in `src/content/nodes/`. Ballpark, Raup's Cube and Conway's Life are `kind: game` nodes (no project page; `▶ PLAY` badge).
- `category`: one of the three ids. Required for plants, substations and games; absent for sections (the schema refuses either mistake).
- `tags`: a list of short strings, default empty, shown as small mono chips on the plate (`Multi-agent`, `Reinforcement learning`, `WebGL`, `Berkeley`…).
- `order`: the order inside a category. Categories render in the fixed order above; an empty one isn't rendered. A new node file with a category lands in its row with no code change.
- `tests/fixtures/nodes.ts` (`MENU_NODES`) mirrors the files, and a test checks it against them.

### Layout
- A trunk runs down from the PROJECTS switch. Each category is a **header** on the trunk (a small glyph, the label, a count and the tagline) with its **row of cards** under it.
- **Wide (≥ ~1128px):** the trunk on PROJECTS' left edge, cards 3 per row with hanging plates.
- **Tablet (stacked):** the same with the trunk on the left of the full-width PROJECTS fence; cards 3 per row.
- **Phones (column):** headers and cards along the single spine; the tagline wraps under the label.
- Cards shown while collapsed: **3 on wide, 2 on tablet and phones**. A row with more ends with a **Show more** button (`Show 2 more` ↔ `Show less`): a real `<button>` with `aria-expanded` and `aria-controls` (the category's list), right-aligned under the row on wide and tablet, under the cards on phones. No hidden cards, no button.
- Plates gained a row of tags: hanging plates are 126px tall, side plates 88px (one line of badge + tags on phones). A chip that doesn't fit drops out of sight rather than being cut; a single long one ends in an ellipsis.

### Expand and collapse
- `Spring`, critically damped, no CSS transition for the gesture. The header answers on pointer-down (its charge sweep); the click toggles, so keyboards work. A press mid-animation reverses from wherever the springs are.
- Expand: the rows below slide open first, then the energy front runs out to the revealed cards and they spring in. Collapse: the front drains first, then the rows close.
- Hidden cards are `inert` (out of the tab order and the accessibility tree) until revealed. Collapsing never loses focus: a focused card about to go hands focus to the button.
- Reduced motion: instant state change and a fresh still frame. Reduced transparency and more contrast: solid button and plate backgrounds, stronger borders and text.
- The expanded categories are remembered for the tab in `sessionStorage` (`gero-menu-cats`, wrapped in try/catch).

### The flow
- Same decorative engine as before, one more level: root → switch → **category header** → card. Every visible card and every header is a load (an anchor); hidden cards are disabled loads, so their packets fade out and nothing flows to them.
- The engine always runs on the fully expanded layout. A collapsed category's extra rows are a **band** squeezed shut on screen (`menuBands`, `squeezeRow`, the same mechanism as ABOUT ME's collapse): corridors, electrons and DOM below it slide up by whole rows, so everything stays on the lattice. On wide the bands only cover the PROJECTS columns. Expanding re-opens the band and the flow reaches the new cards as soon as they power on. Resize and mode switches rebuild the layout (3 ↔ 2 shown).
- Hover or focus on a card pulls the flow to it; hover on a header, or hover/focus on its Show more, pulls it to the header.
- The reduced-motion still frame and the Canvas fallback (`?renderer=canvas`) work as before.
- The v2 card menu (`ProjectMenu.astro`, `GridMap.astro`, `src/grid/main.ts`) is not mounted any more and was not changed beyond what the new `game` kind needed.

## News wire
Decided 2026-10-27. A daily feed at `/news` that Gero reads himself: clean tech, AI, and the world headlines he has to know (global, the US and Mexico). Public, in English, `noindex`, and left out of the sitemap. It doesn't break "no backend": a GitHub Action builds each edition ahead of time, and the site stays static.

### The funnel (once a day, ~06:00 PT)
1. **Fetch** about 30 RSS/Atom feeds (`src/news/sources.ts`). Each feed has a 10 s timeout and a failure skips only that feed. Keep items from the last 30 h, at most 25 per source.
2. **Normalize and dedupe**:
   - Canonicalize URLs: drop tracking parameters, fragments and AMP.
   - Collapse duplicates by canonical URL.
   - Drop what any of the last 3 editions already ran, by URL or by story key.
3. **Classify** with Claude Haiku 5.5, structured output, in chunks of 20. Input is only the title, source, date and feed summary.
   - **Categories:** `cleantech | ai | world | none`.
   - **Relevance** 0–10: fit with Gero's interests (`src/news/profile.md`).
   - **Importance** 0–10: global significance, independent of his interests, so the feed doesn't become a bubble.
   - **Snippet:** one sentence of ≤ 30 words, in its own words.
   - **English title** for Spanish-language sources.
   - **Story key:** a short slug.
4. **Cluster**: same category, plus the same story key or title-token Jaccard ≥ 0.5. Cluster size is the coverage signal. The representative comes from the highest-weight source.
5. **Score**: a weighted sum of relevance, importance, log coverage and source weight, minus a recency decay. Candidates: the top 15 per category, plus the top 15 by importance.
6. **Edit** with Claude Opus 5.5:
   - It picks 3–5 **Must know** stories, then ≤ 6 per section in reading order, each with a ≤ 12-word "why it matters to Gero".
   - It returns ids only. It never writes URLs or rewrites snippets.
   - If it fails or its output doesn't validate, the scores alone pick the edition (`degraded`).
7. **Brief** (Haiku 5.5): 2–3 sentences, 50–75 words, for each story picked: a little more than the headline, not the article.
   - Written from the article text when the page can be fetched (honouring robots.txt), otherwise from every summary in the cluster.
   - `basis` records which of the two it came from.
8. **Validate and write** `src/content/news/YYYY-MM-DD.json`. The edition carries a `meta` block, the audit trail: counts per stage, failed feeds, tokens, estimated cost, models, and whether the fallback was used.

### Guardrails
- Feed and article text is untrusted. No tools in any call, and structured output only. Every link comes from the feed, never from the model, and must be http(s). All text is rendered escaped.
- We publish a headline, our own sentence and paragraph, and the link. A snippet or brief that repeats a run of 8 or more consecutive words from its source, with at least 5 content words in it, is regenerated once (told the words it reused), then dropped. Figures, proper names and function words don't count, so restating numbers and names passes. Article text is never published.
- The run aborts above $0.50 estimated (expected ≈ $0.10). Hard cap of 400 items.
- If classification fails outright, nothing is committed and the page keeps the last edition.

### The page
- **Layout:** one column on phones, two from 760px, four from 1200px (Must know, Clean tech, AI, World side by side), so the day reads across instead of down. Each column grows on its own when a card opens.
- `/news#s-<id>` (a story picked on the home page) opens that card, marks it read and scrolls it into view.
- `/news` is the latest edition. `/news/YYYY-MM-DD` covers the last 14, with prev/next links.
- Header: "Today's wire", the date and the update time (mono), and "N new".
- Sections in order: **Must know**, **Clean tech**, **AI**, **World**. Under the header, a row of section links with counts, for jumping on a phone.
- Headlines drop live-blog and media labels ("Live Updates:", ", live:", "– video explainer"); a live blog gets an amber `LIVE` chip instead.
- The snippet adds what the headline doesn't say (a number, the cause, what's next). It's a teaser: when the card opens, the brief replaces it.
- **Each story is a phone-style notification card**: a glass card with large radius.
  - Top row: the category glyph, the source, an `ES` chip, and the age (mono).
  - Then the bold title (2 lines) and the snippet (muted, 2 lines).
  - **Pointer-down** presses it (0.98).
  - **Tap** expands it in place on a `Spring` (interruptible, from the current height): the brief, the "why" line, "Also covered by" links, and a "Read on <source> ↗" pill.
  - Several cards can be open at once, so nothing above jumps.
  - Each card is a native `<details>`/`<summary>`, so it works without JS and from the keyboard. Under reduced motion it opens instantly.
- **Read state:** expanding a story or opening its link marks it read, in `localStorage` (inside try/catch). Read cards dim; "N new" counts the rest.
- **Stale banner:** if the edition is more than 36 h old, an amber "Wire stale since …" banner.
- The PWA manifest has a "News" shortcut. On the home page, the news wire is the left section of the grid (SPEC "Home hero v4").

### Automation
- `.github/workflows/news.yml`: cron `0 13 * * *` plus a manual trigger. The job runs `npm run news`, then commits the edition to `main`, and Vercel redeploys.
- The `ANTHROPIC_API_KEY` repository secret is set by Gero.
- `npm run news -- --dry-run` runs the whole funnel on fixtures with a fake Claude.

## Physarum
Decided 2026-10-27. A fifth interactive at `/physarum`, in "Math & Nature": the slime mold *Physarum polycephalum* building transport networks between food, after Tero, Nakagaki et al., "Rules for biologically inspired adaptive network design", *Science* 327 (2010). The page joins nature, networks and optimization. It stays off the home menu until Gero has play-tested it.

### The science (what the page claims)
- The plasmodium is one giant cell. Protoplasm shuttles through its tubes. Tubes that carry more flow thicken, and tubes that carry little thin out and vanish.
- In the experiment, 36 oat flakes stood for the cities around Tokyo. The mold grew out from Tokyo, and light kept it off mountains, lakes and sea, which it avoids. Within about 26 hours it had thinned to a network.
- The networks were scored on cost (total length, TL), transport efficiency (mean shortest distance between food pairs, MD) and fault tolerance (FT: the chance that a single random link failure does *not* cut off part of the network). TL and MD are normalised to the minimum spanning tree (MST).
- Results: rail TL ≈ 1.8 × MST and the mold's 1.75 ± 0.30; MD 0.85 for both; 4% of single faults would disconnect the rail network and 14 ± 4% the illuminated mold networks. The Delaunay triangulation is ~4.6 × MST.
- The model (Tero et al.): a fine random mesh of tubes. Each step a random food is the source (+I₀) and another the sink (−I₀). Kirchhoff gives the pressures, and `Q = D/L · Δp`. Then `dD/dt = f(|Q|) − D` with `f(Q) = Q^γ / (1 + Q^γ)`. A higher I₀ (or a lower γ) keeps more cross-links: more robust but more expensive. Tokyo was seven food sources.
- The live, organic layer is Jeff Jones's agent model (2010): particles with three sensors follow and lay down a diffusing, decaying trail.

### Models
- **Growth** (`src/physarum/growth.ts`, decided 2026-11-01 after play-testing): every fresh board first spreads, as the real plasmodium explores. Each origin (every food; on the Kanto map Tokyo alone, `scene.origin`, as in the experiment) grows a tree over the flow mesh: the shortest-path forest under random tube costs (length × 1 ± 0.6, first-passage percolation), so strands fork and wander. A vertex is reached at its cost distance and its tube grows out from the parent, so tips advance; where two trees touch, up to three of the cheapest tubes per pair (0.12 apart) fuse, grown from both ends to meet in the middle. Thickness follows how much a tube feeds (√(vertices below / 120)). Drawing positions are smoothed along the strands. The flow model is held during growth (9 s at Normal, 16 Slow, 4 Fast, 3 in the race; it waits for two foods), then starts from the strands: strand tubes at 0.5 + 0.5 × thickness, fused tubes 0.75, every other tube a film at 0.2 × f(I₀) ± 25%. Settled networks stay within the old seed-to-seed spread (Tokyo at I₀ 2 ≈ 1.5× / 0.76× / 84%).
- **Flow** (`src/physarum/flow.ts`): the Tero model on a jittered triangular lattice, minus the lit vertices. Each food keeps a potential (warm-started conjugate gradient), so a step costs two short solves. A tube never thins below a floor (a film of plasmodium), so after a cut the flux leaks round and a new route thickens. Defaults: I₀ 2, γ 1.8, dt 0.05, lattice spacing 0.03 on a 1 × 0.625 board (~850 vertices); a network forms in ~1,200 steps. `extractNetwork()` drops dead ends, contracts chains into links between foods and junctions, and smooths each link's path. This is the measured network.
- **Agents** (`src/physarum/agents.ts`, GPU in `render-gl.ts`): the Jones model on the same scene. This is the picture, not the measurement. The agents are drawn to an attractant field (food, plus every tube weighted by D / f(I₀)) and lay trail only where that field is, so the mold fills the fine mesh at first and gathers on the tubes that survive, with no self-sustaining strays off the network. While the board grows, the attractant is the grown part of each strand, rebuilt about 11 times a second.
- **Runtime:** the flow model runs in a Web Worker (`flow.worker.ts` around the DOM-free `FlowRunner`, or on the main thread without workers) and posts the conductivities, the network and its metrics about 15 times a second. Once the network has settled (TL within 1% over 6 time units, and under half the live mesh's length, so a fresh mesh never counts) it slows to 40 steps a second. Each init carries a generation number that comes back on every state, so the page drops states from the board it just replaced. WebGL2 runs 131k agents (98k on phones) on a 640 × 400 trail (480 × 300 on phones); the Canvas fallback runs 14k on 320 × 200. Each new growth goes to the page once as a `growth` message (`takeGrowth`); states carry `grow: {tau, end, rate}` while growing, and the page runs `tau` on between states so the tips move smoothly. States also carry `inNet`, the tubes of the measured network. Drawing (`flowWeights`, `smoothAlong` in growth.ts): strands by √(D / f(I₀)), network tubes at least faintly; film only in the network, and only once the flow has thickened it past 0.3 × f(I₀) or after 5 time units (when unused film has decayed out of the network), so the lattice never shows. Tube positions are relaxed along the tubes that show, so chains draw as curves. Speeds: Slow 60, Normal 120, Fast unlimited rounds a second.
- **Reference networks** (`src/physarum/reference.ts`): MST, Delaunay, and an approximate Steiner tree (Fermat points inserted into the MST, then Weiszfeld).
- **Metrics** (`src/physarum/metrics.ts`): TL, MD and FT, where FT = 1 − bridges / links on the contracted network, plus TL/MST and MD/MST.

### Modes
- **Sandbox:** place, move and remove food; paint light; cut tubes; tune I₀; view Mold, Tubes or Both; Skip ahead; Start over.
  - Board: 1 × 0.625 landscape, or 0.625 × 1 portrait when the window is taller than wide. Opens on a nine-food example.
  - Food tool: pointer-down on empty dark board places food at once (up to 40); drag moves it; a tap on an existing food removes it. Light tool: drag paints a soft brush; starting on light erases. Cut tool: a drag cuts every tube it crosses and leaves a dashed scar. Start over restarts the fine mesh (and heals cuts). Moving food, painting light and cutting never start over: the model adapts from where it is.
  - Dock: Play/Pause, Skip ahead (1,500 rounds at once), Start over, Food / Light / Cut, I₀ (0.2–8, log scale). There is no single-step button and no model-time counter: the page calls model steps "rounds" (the tour's steps are its chapters). The panel holds View (Mold / Tubes / Both), Speed (Slow / Normal / Fast), Example board and Clear board.
  - Panel top (in the phone sheet's peek too): a three-stage bar, **1 Spread → 2 Thin out → 3 Settled**, from the runner's `stage` (spread while the strands grow, and after while the extracted network is still over half the live mesh; thin after; settled by the settle rule), then one plain sentence on what is happening (prefixed "Paused." when paused), then the three metrics. The metrics show at 30% opacity while spreading and 60% while thinning, since they only mean something once it settles. The challenge hides the bar.
  - Panel body (2026-11-10, Design language). The head is the story hook: "In 2010 a single cell with no brain was set down on a map of Tokyo…". Then the Sandbox pane:
    - the three-lens strip (anchor links);
    - **Nature**, *What the slime mold does* (a single cell, not a fungus; use it or lose it; the footpaths analogy);
    - **Try it**: the tools, the time controls, speed, Example and Clear board, and Take the tour;
    - **Math**, *The math*: four plain rounds, Fig. 1 (the three stages grown by `growth.ts` on a small lattice in the frontmatter), then Fig. 2, the three equations in MathML (flux, Kirchhoff, the conductivity update with f) with captions and I₀;
    - **Engineering**, *Cost against resilience*: the three metrics and Fig. 3, the live trade-off figure (spanning tree, Steiner tree, Delaunay, the 2010 Tokyo rail and the mold);
    - *For the curious*, a closed `<details>`: how it spreads, the two models with the Mold, Tubes and Both switch, time scales, and sources.

    The Tokyo pane adds Fig. 4, the same figure with the Kanto rail sketch. Under the board a plate caption names the mode (Plate I to IV). The readings sit on a specimen label.
  - Keyboard: arrows move a cursor on the board (Shift for bigger steps), Enter places or removes food (or paints light); Space plays or pauses.
  - Hash: `#n=x,y;…&l=<light runs>&i=<I₀>&o=p`.
  - Reduced motion: no autoplay and no shuttle pulses; a fresh board shows its grown strands at once (growth skipped), and Skip ahead and Start over still work. An agent burst after Skip ahead animates the picture only; the flow stays put.
- **Tokyo:** a stylized Kanto (`src/physarum/kanto.ts`). The panel's tabs are Sandbox, Tour, Tokyo and Challenge; the last three put their own boards up, and the sandbox board comes back on returning to the Sandbox.
  - Map: 34 cities at rounded real positions (Tokyo weighted 7, as in the paper's model), nudged inland where the coast is close. Light: the Pacific with Sagami Bay and Tokyo Bay, Lake Kasumigaura, the western mountains and Mount Tsukuba. The map is projected (x scaled by cos 35.7°) and fitted to the board, landscape or portrait. The overlay draws the coast and lake shore, the sea and mountain names, and the city names (major cities only on boards under 620 px wide).
  - Rail sketch: 53 straight links along the main lines (Tokaido, Chuo, Odakyu, Musashino, Joban, Sobu and others), with some parallel and secondary lines left out. It scores 2.15× cost, 0.68× travel and 91% robust on this map.
  - Comparison: rows for Mold (live), Rail lines, Spanning tree and Delaunay, each with cost, travel and robust (against the same spanning tree); picking a row draws it in cyan on the board (Rail by default, Mold draws none). A note gives the paper's numbers (rail 1.8×, 0.85×, 96%; mold 1.75 ± 0.30×, 0.85×, 86%), and one line says the map is stylized and the comparison illustrative.
  - The map is fixed: Food and Light are disabled and the tool is Cut. The mold spreads from Tokyo alone. I₀ starts at 2, where the model settles near 1.5× cost, 0.76× travel and 84% robust; at about 3 it costs ~1.7× and 96% robust.
  - Hash: `#m=tokyo&i=<I₀>`.
- **Challenge (You vs the mold)** (`src/physarum/challenge.ts`): lay straight track between towns within a budget, then race the mold on the same map.
  - Levels: Five towns (budget 1.6× MST), Round the lake (8 towns round a lit lake, 1.6×), Nine towns (1.7×; was 1.5× before the growth phase, when its mold cost 1.38×), The pass (10 towns either side of a lit ridge with one gap, 1.6×), Twelve towns (1.5×). Towns are seeded, at least a set gap apart, laid out landscape and transposed for portrait. Measured mold (I₀ 2, 1,500 steps, landscape): 1.43× / 0.86× / 83%, 1.35× / 0.83× / 100%, 1.38× / 0.92× / 83%, 1.45× / 0.95× / 75%, 1.28× / 0.82× / 85%. Race molds (seed 1, I₀ 2, grown first): Five towns 1.39× / 0.87× / 67%, Round the lake 1.40× / 0.83× / 100%, Nine towns 1.58× / 0.93× / 79%, The pass 1.56× / 0.98× / 85%, Twelve towns 1.46× / 0.80× / 95%; a test keeps every budget above its mold.
  - Tools: **Track** (drag from a town, a junction, a point on a line, which splits it, or open ground, which makes a junction; the drag shows a dashed preview, grey when it can't be built) and **Erase** (tap or scrub; a junction goes with its links, except one on a straight line, which loses only its branches and leaves the line whole). Undo and Clear track. Track can't cross light or pass the budget, and both say so in the live region. Keyboard: Enter starts and then lays a line at the cursor, Escape cancels.
  - Scoring (`measure`): cost counts every length built; travel and robust use the track with dead-end junctions pruned and two-link junctions contracted, as for the mold. Against the mold: cost and travel tie within 2%, robust within 2 points; lower cost and travel win, higher robust wins. Verdict: beat (a win and no loss), lost, trade-off, tie, or unfinished (not every town connected).
  - The race: the mold is hidden while you build (no agents, no tubes, Play disabled). Race the mold re-inits the model with the same seed (so a level's mold is the same every race) and runs it flat out with the mold drawn, until it settles or reaches 1,500 steps; then the scores show (win / tie / lose per metric, the verdict). Editing the track after the race rescores it against the same mold.
  - In this mode the top readout shows your track, and its status shows the budget, then "n won · n lost". The dock shows Play, Race the mold, Undo, Track and Erase, and hides Skip ahead, Start over and I₀.
  - Progress: `physarum-progress` gains `challenge: {at, best: {level: {margin, beat}}}` (margin = wins − losses, the best kept); a level's dot is tinted once beaten.
  - Hash: `#m=challenge&c=<level id>`.
- **Tour** (`src/physarum/tour.ts`): seven steps, each with its own board (laid out landscape and transposed for a portrait board), the tools it allows, its I₀, and a goal checked against the flow model's settled readings. The panel shows step dots (done ones tinted), "Step n of 7", the text, the goal (a check when met), and a sticky Back / Reset board / Next bar; Next lights up once the goal is met but never waits for it.
  1. **One cell, many nuclei:** two foods thin to one tube (I₀ 1; at 2 parallel tubes survive). Food and Cut. Goal: settle.
  2. **The maze** (Nakagaki, Yamada & Tóth 2000): a 7 × 4 maze drawn in ASCII in `tour.ts`, walls as light, food at opposite corners, a 13-cell way and a 21-cell way round, and dead ends. Cut only. Goal: settle (on the short way, travel ~1.16×; cut it and it takes the long way, ~1.93×).
  3. **Three foods:** an equilateral triangle with its spanning tree drawn in cyan (redrawn as foods move). With the default γ 1.8 the model keeps two sides; this step runs γ 3 with seed 13, which grows a junction (cost ~0.89×; about one seed in four does). It still often settles for two sides after a food moves, and the text says so: the mold finds good networks, not always the best. Goal: cost under 0.97×.
  4. **The I₀ knob:** the nine-food example board. Each change of I₀ (on release) starts the mold over. A tree at low I₀ is only about even odds (loops often survive, and evenly spread boards keep them always), so the goal is the trade-off: settle once with I₀ under 1 and once over 4, shown side by side (about 1.0× and 0% robust against 2× and 100%).
  5. **Light is terrain:** two foods and a lit block; Light, Food and Cut. Goal: paint light, then settle.
  6. **Tokyo:** the Kanto map with the rail sketch in cyan, Cut only, a button to the Tokyo tab. Goal: settle.
  7. **Beyond the dish:** cards for Adamatzky et al., "Are motorways rational from slime mould's point of view?" (2013; 14 regions, closest in Belgium, Canada and China) and Burchett et al., "Revealing the dark threads of the cosmic web" (ApJL 2020; Physarum-style agents on ~38,000 SDSS galaxies). Keeps the board as it was. Done on arrival; Back to the Sandbox and Start the tour over.
  - Progress in `localStorage` (`physarum-progress`, `{tour: {at, done}}`, other keys kept), inside try/catch; the tour reopens on the step you left. The Sandbox has a "Take the tour" button.
  - Hash: `#m=tour&s=<step id>`.
  - Phones: the panes are padded by how far the sheet sits below the screen, so the end of a pane and the tour's bar stay reachable in the half sheet.

### Design language
Decided 2026-11-10 (supersedes "Look"). The page is a naturalist's field notebook crossed with an engineering drawing, in the spirit of D'Arcy Thompson's *On Growth and Form* and Haeckel's plates: biophilic, calm and alive. The review that led to it is `docs/physarum-review.md`.

- **The dish.** The site is dark-only, so the board is a dark petri dish: deep moss-black agar (`--dish`) with a faint grain and a darker rim (vignette). It is never pure black. The panel, dock and tabs are re-tinted inside `.phys` from the same family, so the page reads as one warm, dark specimen table. A paper (agar-cream) theme would need a site-wide light mode, which the site doesn't have.
- **Palette** (tokens in `tokens.css`, `--phys-*`; no hex in components). The page overrides `--ink`, `--amber`, `--cyan` and the rest inside `.phys`, so shared components follow.

  | Token | Colour | Used for |
  |---|---|---|
  | `--phys-dish` | `#12150f` | the agar |
  | `--phys-plasm` | `#f0c02c` | chrome-yellow plasmodium |
  | `--phys-ochre` | `#b9801f` | old, thick tubes and the mold's mid-tones |
  | `--phys-glow` | `#fff0b0` | luminous cores |
  | `--phys-oat` | `#d8c6a0` | food (oat flakes) |
  | `--phys-paper` | `#ece2c8` | text, annotation ink |
  | `--phys-moss` | `#5d7a45` | accents: done marks, focus, links |
  | `--phys-draft` | `#93aebb` | drafting ink for engineered networks: rail, MST, Delaunay and the player's track, drawn thin and dashed like a technical drawing |
  | `--phys-lamp` | — | light is a warm lamp haze |

  No neon and no cyan.
- **Living matter.** Tubes are drawn as soft, glowing, slightly translucent strokes: a wide faint halo under an ochre-to-chrome body and a pale core on the thickest ones, with rounded caps.
  - Width follows conductivity as before.
  - Shuttle streaming is a slow peristaltic wave of brightness and thickness travelling along the board, not dashes. The real period is about 100 s; it is shown at about 8 s and labelled "sped up".
  - Growing tips glow softly.
  - Oat flakes are irregular beige flakes, not dots.
  - The agents' trail maps dish → ochre → chrome → glow.
- **Three lenses.** Nature, Math and Engineering are a recurring motif:
  - a three-part strip under the story;
  - lens tags on the Sandbox sections and on every Tour step;
  - the Tokyo tab framed as Engineering.
  
  What each lens covers:
  - **Nature:** what the organism does.
  - **Math:** Tero's model, with real equations in MathML (Kirchhoff's law, flux, the conductivity update and the response f), each with a plain-language caption.
  - **Engineering:** the cost against resilience trade-off. A live figure plots cost (× MST) against robustness for the spanning tree, the Delaunay mesh, the Tokyo rail sketch and the mold.
- **Annotation layer.**
  - Figure numbers and captions under the board ("Fig. 1 · *Physarum polycephalum* on agar …"), in serif italic.
  - Hand-drawn-feeling callouts on the board in Sandbox and Tour: a slightly wobbly leader line and an italic label for an oat flake, the growing front (the tip farthest from any food), and the busiest tube (kept while it stays thick).
    - Boards under 520 px wide get one short note.
    - Labels are clamped inside the board, and the flake note keeps away from the other note.
  - On phones the half-open sheet snaps to 30% and hides the readings, so the pane has room to read.
  - The measured readings appear as a specimen label: a ruled card with a serif heading, mono values and italic captions.
- **Typography.** A humane serif (`--serif`: the system's New York, Iowan Old Style or Palatino, falling back to Georgia; no web font is downloaded) for headings and narrative. The site's sans is kept for controls, and `--mono` for numbers and labels. This is a deliberate, page-scoped exception to the site's system-sans rule.
- **Motion.** Slow and organic: eased fades of about 400 ms, the step-in rise, and the streaming wave. Nothing snaps. Under `prefers-reduced-motion` the wave, the callout drift and the step-in animation are off, and the board shows the grown strands still.
- **Explanation first.** The panel opens with a story hook (a single brainless cell that redesigned Tokyo's rail network), then progressive disclosure in the Sandbox: **Story** (Nature) → **Try it** → **The math** (Math) → **Cost against resilience** (Engineering) → **For the curious** (a closed `<details>`: the growth model, the two models, the board options and the sources).

## Home hero v4: News wire on the grid
Decided 2026-10-28 (supersedes v3's ABOUT ME section and the fixed section nav).
- **Root:** the photo is 80px and the name 2.25rem (1.875rem on phones).
- **The root's links:** About, Off the grid and Contact are small nodes (30px glyph, one-line glass plate), fed straight from the root (no switch) and lit with it.
  - Wide: beside the root's plate, on its row, when they fit before the fences' right edge; otherwise in a row under the root.
  - Stacked: in a row under the root.
  - Phones: in a row under the root, each label centred under its glyph (it wraps on the narrowest phones).
  - The fixed glass section nav (`SectionNav.astro`) is gone from the home page.
- **NEWS WIRE** takes ABOUT ME's place (the left column on wide, the first section on stacked and phones), behind its switch like before:
  - The latest edition's top 3 stories (Must know first), as side nodes. Each plate shows the outlet, `Live` for a live blog, and the age (live against the viewer's clock), then the headline in up to three lines.
  - A story opens its card on `/news`.
  - A last node, "All N stories · Today's wire", opens `/news`.
  - The home page is rebuilt with every edition (the daily commit redeploys), so the section updates daily.
  - Phones: side plates two rows apart (a headline needs two lines), so Projects starts below the first screen.
- **Engine:**
  - `menuLayout` takes `news`, `links` and `rootW` (the root plate's reach right of its vertex, measured from the plate), and returns `links` (vertices, style `compact | stack`, plate width, placement `beside | under`).
  - Under-placed links push the fences down a row.
  - The links are flow anchors (`link/k`), and each has a root feed.

### v4.1 (2026-10-28, after Gero's review)
- **Links:** wide puts them as far right as they go (the last plate ends by the fences' right edge, the row spread back toward the root, at least 3 spacings apart). Their pills fill their slots, so the row runs across the page.
- **Headings outrank what they hold:**
  - Section switches have a 56px glyph and a 1.25rem label; category headers a 46px glyph and a 1.125rem label (cards are 44px).
  - The trunk (root → switch → header) is drawn 1.8× wider and brighter at rest (alpha 0.72, against 0.42 elsewhere).
  - It carries more current: switches get 4 shares of new packets and headers 2 (`GridGame.setLoadWeight`).
- **NEWS WIRE by category:** Must know · Clean tech · AI · World (empty ones left out), with headers on the trunk like PROJECTS.
  - **The grid:** the featured category (the first) shows its top 3 stories as side nodes, then an **All N stories →** control. The other categories are off the map (dark, out of reach, not in the flow).
  - **The full wire** (All N stories, or arriving on `/#news`):
    - NEWS WIRE's front drains to its switch, the menu re-lays out, and the front runs out again: the fence grows to the full width, and every story powers on along the grid as the current reaches it.
    - Wide puts 4 stories per row, stacked 3, phones 1, with hanging plates (outlet, age, headline).
    - PROJECTS collapses under it (one tap opens it) and is restored on the way back.
    - **← Back to the grid** sits on NEWS WIRE's fence, top right. The browser's back and forward move between the two views (`#news`).
- **A story's panel:** tapping a story (in either view) opens a glass panel on a spring: section, outlet, `Live` / `ES`, age, headline, brief, why, also-in links, **Read on <outlet> ↗** and **On the wire** (its card on /news).
  - Another story swaps the panel's content. Escape, × or a press elsewhere closes it, and focus returns to the story.
  - It marks the story read (shared with /news, in `localStorage`).
  - Desktop: bottom right, 27rem wide. Phones: full width within the gutters. Without JS, a story opens its card on /news.
