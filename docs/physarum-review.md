# /physarum review (2026-11-10)

Before the "Design language" pass. Covers Sandbox, Tour, Tokyo and Challenge at desktop (1440 × 900) and phone (375 × 812) widths.

**How this was checked.** The in-app browser isn't available in this session. Safari's WebDriver needs "Allow remote automation", and no other browser is installed. So the review draws on:
- the page source;
- the screenshots of every tab taken during the build sessions (desktop, phone and the Canvas fallback), up to and including the growth pass of 2026-11-01.

New screenshots will need one of two things: Safari's "Allow remote automation" switched on (Safari ▸ Settings ▸ Advanced ▸ "Show features for web developers", then Developer ▸ "Allow remote automation"), or an OK to install Playwright's Chromium.

## What looks artificial or "techy"

- **Neon on near-black.** The page inherits the site's grid palette:
  - cyan `#5fe3ff` for the rail, MST, Delaunay and the player's track;
  - an `#ffb547` amber mold on a `#0a1018` board.
  
  The result reads as a sci-fi HUD, not a living thing on agar. The cyan rail and the amber mold also fight for attention on the Tokyo tab.
- **Hard tubes.** Tubes are solid strokes in six width buckets, so they look like vector lines laid on top of the mold, not part of it. The settled network in particular reads as one uniform, slightly wobbly wire.
- **Morse-code streaming.** Shuttle streaming is drawn as moving white dashes along the network. It reads as "data flowing in a diagram", not protoplasm surging.
- **Food is a glowing white dot.** Nothing about it says "oat flake".
- **Light is a flat white wash.** It reads as a selection mask, not a lamp.
- **Interface chrome:**
  - uppercase mono kickers, small-caps metric keys, pill chips and a frosted-glass panel;
  - the readout (`COST 1.44×  TRAVEL 0.89×  ROBUST 100%`) looks like a dashboard tile.
- **One typeface throughout.** Everything is the system sans, so the narrative and the data have the same voice.
- **No sense of scale or time.** There is no dish, no figure caption and no "this is sped up" note, and the board is an anonymous rounded rectangle.

## Where a lay visitor gets lost

- **The first screen is mostly controls.** The panel opens with:
  - a one-line lede;
  - four tabs;
  - a three-stage bar;
  - three metrics with jargon names, each "vs the shortest tree";
  - a long Sandbox pane.
  
  The hook (a brainless cell redesigned Tokyo's railway) is in there, but as the fourth paragraph.
- **Metrics come before meaning.** "Cost 1.44×" appears before the visitor knows what it is compared with (the minimum spanning tree is explained much further down).
- **Two models, one picture.** Mold, Tubes and Both, and "the dots are a second model", are honest but confusing. A visitor can't tell which part is the organism and which is the computation.
- **No equations.** The math is told in prose ("like current in a circuit"). Someone who wants the actual model has to go to the paper. Someone who doesn't gets no visual anchor either.
- **The engineering point is buried.** The cost against resilience trade-off is the punchline of the whole story, but it appears only as three numbers per row in a table on the Tokyo tab. No figure shows that the mold sits between the cheap, fragile tree and the expensive, robust mesh.
- **I₀ is a Greek letter with a slider.** Its meaning ("how hard the foods pump") lives in the panel, far from the knob.
- **On phones:**
  - the sheet's peek shows the stage bar and the metrics, but not the story;
  - the dock has two rows of small controls.
  
  First-time visitors see controls before they know why.

## What is strong and should be kept

- **The model is real and honest.** It is Tero's flow model with Kirchhoff, the conductivity update and the paper's three metrics, normalised to the MST. The growth phase now starts it from strands the mold actually grew.
- **The growth.** Strands fork from the food and fuse in the middle, and on the Tokyo map they fan out from Tokyo. This is the most natural-looking part of the page.
- **The three stages** (Spread → Thin out → Settled), with the matching three-panel diagram and one plain sentence of status.
- **Plain-language writing:** "What the slime mold does", the footpaths-on-a-lawn analogy, and the four numbered rounds.
- **The Tour.** Seven steps, each with a board and a goal, from the maze to the cosmic web.
- **Tokyo.** The stylised Kanto map, the live comparison against the rail sketch, the MST and Delaunay, and the honesty note.
- **Challenge.** Building track against the mold is the best "aha" for engineers: you feel the trade-off.
- **Accessibility and robustness:**
  - keyboard control, the screen-reader live region, and reduced motion, transparency and contrast;
  - the Canvas fallback, the Web Worker, and storage inside try/catch.
