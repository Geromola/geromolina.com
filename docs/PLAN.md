# Plan

Status key: [x] accepted · [~] in progress · [ ] pending. Spec: `docs/SPEC.md`.

## Done
- [x] Scaffold: Astro, TypeScript, Vitest, tokens, photo asset.
- [x] Grid prototype (transformer under the cursor). It is superseded by the game, but the renderers, the spring and the layout are reused.

## Tasks
1. [x] **Game engine** (careful). Pure TypeScript in `src/grid/`, with no DOM:
   - routing on the state graph (vertex, level), with a backward Dijkstra per load
   - electrons as energy packets with level, energy and target, using softmax routing
   - the per-edge heat accumulator
   - level definitions with seeded faults
   - the solver and star scoring
   - a public API the UI can drive: `placeTransformer`, `removeTransformer`, `moveTransformer`, `canPlace`, `setLevel`, `evaluate()`, `step(dt)`, plus output arrays

   Replace the old cursor-field and AC/DC logic in `sim.ts`. Verification: Vitest covers
   - the loss physics (HIGH loss = LOW / 625)
   - that routing prefers the HV corridor when one exists
   - that arriving at HIGH is not delivered
   - each level solvable on the 3 reference layouts, while the empty board doesn't win
   - solver runtime under 50 ms
   - deterministic faults per seed

   The browser keeps working only as far as `main.ts` compiles; the UI is task 3.
2. [x] **Nodes content collection** (medium). Move `MAP_NODES` into `src/content/nodes/*.md`, with a zod schema in `src/content.config.ts`. Fields: id, kind, title, kicker, href, locked, land, port, order, and, for plants, pitch, liveUrl, repo, metrics[3], embed. The body is "How it works".
   - `GridMap.astro` reads the collection and passes the nodes to the client script through a `data-` JSON attribute or `define:vars`. `src/grid/nodes.ts` keeps only the `MapNode` type.
   - Verification: `npx astro check` and `npm run build` are clean, and the home page renders identically.
3. [x] **Game UI and level panel** (careful), after 1 and 2. Rewire `src/grid/main.ts`, `GridMap.astro` and `renderers.ts` for the game, following SPEC "Interaction", "Level panel", "Fun-fact toasts" and "Reduced motion". Draw the heat layer in both renderers. Remove the cursor transformer, AC/DC and the old meter. Update the hero line to "Energy nerd who builds things. Place transformers, power the grid." Verification: browser at desktop and mobile sizes, plus `?renderer=canvas`.
4. [x] **Home sections and node list** (medium), after 2: About, Off the grid, My tools, Contact, and an accessible node list. The copy is supplied by the orchestrator.
5. [x] **Project pages and 404** (medium), after 2.
6. [x] **Charge-up and view transitions** (careful), after 3 and 5.
7. [x] **PWA, sitemap, OG, analytics** (light), after 5.
8. [x] **Phone, a11y and perf pass** (careful), after 3, 4 and 6.
9. [ ] Deploy. The orchestrator does this, confirming each outward step with Gero: push to GitHub, import into Vercel, set up Cloudflare DNS (DNS only), enable Analytics.
10. [x] **Ballpark energy game** (careful). `/ballpark`, SPEC "Ballpark". DOM-free logic in `src/energy/`, Vitest in `tests/energy.test.ts`. Built and verified (tests, `astro check`, full runs at desktop and phone sizes, keyboard, `?motion=reduce`, storage blocked); play-tested by Gero, then launched as a `▶ PLAY` node in the home menu's PROJECTS section and added to the sitemap.
11. [~] **Raup's Cube** (careful). `/shells`, SPEC "Raup's Cube".
    - DOM-free model, mesh, morphospace and lessons in `src/shells/`; Vitest in `tests/shells.test.ts`.
    - Built and verified: tests, `astro check`, the build, lessons 1–6, map drag, presets, random shell, hash, keyboard, `?motion=reduce`, `?renderer=canvas`, and 1440×900 and 375×812.
    - Identifier ("What shell is this?"): 16-shell cached catalog with checked facts and credited Commons photos, nearest-match tiers, coil chip. Verified with tests, `astro check` and the browser (desktop, phone, `?renderer=canvas`, `?motion=reduce`).
    - Launched: a `▶ PLAY` node in the home menu's PROJECTS section, and in the sitemap; live on geromolina.com.
    - A 3D cube view (Cube · Slice switch), and the title "Every shell in the world in three numbers: Raup's Cube".
    - Next: check the region boxes against Raup's figure; plan B (a model-based identifier behind the `Identifier` interface).
12. [x] **Conway's Life** (careful). `/life`, SPEC "Conway's Life".
    - DOM-free engine, RLE, detector, library, scenes (signal line, NOT gate, message), camera and tour in `src/life/`; Vitest in `tests/life.test.ts` (38 tests: rules, border, every library claim, scenes, NOT truth table, message round-trip).
    - WebGL2 and Canvas renderers, the page and DOM wiring.
    - Verified: tests, `astro check`, the build, and in the browser preview (built site):
      - 1024×768 and 375×812, `?renderer=canvas`, `?motion=reduce`;
      - drawing, stamping and keyboard;
      - the NOT gate table and the message lamps.
    - Not verified: real-time playback and the sheet's spring in a visible window. The preview pane was hidden, so frames were stepped by hand.
    - Play-tested by Gero, then launched: a `▶ PLAY` node after Raup's Cube in the home menu's PROJECTS section, and in the sitemap.
    - Later, maybe: Sir Robin, an ash census for soups, a Snark scene.
13. [x] **Projects menu by category** (careful). SPEC "Projects menu by category" (decided 2026-10-27).
    - `category` and `tags` in the `nodes` schema; Ballpark, Raup's Cube and Conway's Life became `kind: game` node files; `src/grid/categories.ts`.
    - Category rows, bands and anchors in `src/grid/game/decor.ts`; headers, Show more, springs and the 4-level flow in `src/grid/menu.ts` and `NodeMenu.astro`.
    - Verified: Vitest (grouping, fixture vs files, layout at 10 widths in every expand state, anchors, bands, circuit), `astro check`, the build; WebKit renders at 1440, 1024 and 390 collapsed and expanded, expand/collapse/reverse timing, keyboard order and focus, `?renderer=canvas`, `?motion=reduce`.
    - Not verified: real devices; the in-app browser pane was hidden, so animation was checked in an offscreen WebKit window.
    - ⚑ Gero to confirm the tags (e.g. `Berkeley` on Custom LLM).
14. [~] **Physarum** (careful). `/physarum`, SPEC "Physarum" (decided 2026-10-27). Phases, each verified before the next:
    1. [x] Flow engine (Tero), metrics and reference networks, with Vitest in `tests/physarum.test.ts` (15 tests: scene, metrics on hand-built graphs, MST, Delaunay, Steiner, Kirchhoff and flux conservation, two foods, the maze, rerouting round a cut, the I₀ trade-off, determinism, step budget).
       - Measured on 20 random foods after 1,200 steps: I₀ 0.5 gives a tree (TL 1.04 × MST, FT 0); I₀ 2 gives TL 1.34, MD 0.82, FT 0.52; I₀ 6 gives TL 2.6, MD 0.74, FT 1. A step costs ~3 ms in Node with 20 foods, so phase 2 runs the model in a Web Worker.
    2. [x] Agents (CPU reference + WebGL2), renderers and the sandbox page. `/physarum` is built but not linked from the home menu or the sitemap.
       - Vitest now 23 tests (adds the hash round trip, agents: determinism, bounded trail, nothing under light, gathering at food, tubes in the attractant; the runner: budgeted ticks, settling, food and light messages).
       - Verified in the dev preview at 800 × 600 and 375 × 812: growth to Settled, placing and removing food, painting light (the network reroutes round it), cutting a tube (it reroutes round the cut), Mold / Tubes views, `?renderer=canvas`, `?motion=reduce` with Converge. The preview pane was hidden for most checks, so frames were driven by a timer in place of requestAnimationFrame. The production build bundles the worker (not checked in `astro preview`).
       - Not verified: real devices, frame time on a phone GPU.
    3. [x] Tokyo tab: stylized Kanto and the comparison panel. Sandbox / Tokyo tabs in the panel (in the phone sheet's peek, which hides the title).
       - Vitest now 29 tests (adds Kanto: every city in the dark on both boards, light over the sea, bay, lake and mountains, the rail sketch connected and robust, the model's network connected and off the water).
       - Verified in the dev preview at 1440 × 900, 1280 × 800 (`?renderer=canvas`) and 375 × 812: the map and names, the Rail / Spanning tree / Delaunay / Mold rows, a cut between Tokyo and Kawasaki (the network reroutes through Yokohama; travel 0.77× → 0.90×, robust 87% → 70%), back to the Sandbox (its board returns, the tools come back), arrow keys on the tabs, the half sheet.
    4. [x] Tour: `src/physarum/tour.ts` (seven steps, goals, progress) and a Tour tab between Sandbox and Tokyo.
       - Vitest now 40 tests (adds: every tour board's food in the dark on both boards, the portrait transpose, two foods to one tube, the maze's short way and the long way after a cut, the three-food junction under the tree, the I₀ board's trade-off, a painted wall's detour, goals over several readings, progress parsing and saving, and the runner's generation tag).
       - Tuned on the way: steps 1, 2 and 5 run I₀ 1 (two foods keep parallel tubes at 2); step 3 runs γ 3 (at 1.8 three foods settle on two sides); step 4's goal compares low and high I₀ instead of asking for a tree, which only comes about half the time.
       - Fixed on the way: a fresh mesh counted as settled (TL holds still before any tube has died), which earned goals early; settled now also needs the network under half the mesh. States from a replaced board are dropped by generation.
       - Verified in the dev preview at 1440 × 900, 1280 × 800 (`?renderer=canvas`) and 375 × 812: every step's board and goal, a cut on the maze's short way (it takes the long way), the junction (0.89×), I₀ 0.3 then 5 (1.02×, 0% against 2.10×, 100%), painting light across the tube (it goes round), Tokyo and Beyond, resuming at the saved step, back to the Sandbox, arrow keys over three tabs, the half sheet's bar. Console clean.
       - Not verified: real devices; the phone sheet's full state on the tour.
    5. [x] Challenge (You vs the mold): `src/physarum/challenge.ts` (levels, track building and erasing, measuring, scoring, progress) and a Challenge tab.
       - Vitest now 49 tests (adds: every level's towns in the dark on both boards, building through junctions and branches, refusing light, budget and zero length, erasing incl. a branch point on a line, contraction, the MST against the mold as a trade-off, ties and the unfinished verdict, best-result progress beside the tour's).
       - Shared `layout` moved from `tour.ts` to `scene.ts`.
       - Fixed on the way: the race waited for 1,500 steps, but a settled model runs at 40 steps a second, so it now ends when the mold settles (about 1,150 steps on Five towns). Erasing a branch point used to delete the line it sat on. Leaving the challenge left the model paused.
       - Verified in the dev preview at 1440 × 900 and 375 × 812: a five-link ring on Five towns (1.44× / 0.86× / 100%) against the mold (1.43× / 0.86× / 83%, as in Node): tie, tie, win, "You beat the mold", progress saved and the level dot tinted; track across the lake refused; a branch off a line; Erase and Undo; keyboard track; back to the Sandbox and Tour with tools and Play restored. Console clean.
       - Not verified: real devices, a full play-through of levels 2 to 5 (the budgets are set from the measured mold, not play-tested).
    6. [ ] Play-test by Gero, then launch: node file, `MENU_NODES`, sitemap.
       - Play-test feedback (2026-10-29): the page needed plain-language explanations and the time controls were confusing. Added "What the slime mold does" and "How the computer copies it" (four numbered rounds and a three-panel diagram); replaced Step, Converge, Regrow and the "t" counter with Skip ahead, Start over and a 1 Spread → 2 Thin out → 3 Settled bar with one sentence on what is happening; the metrics stay faint until the network settles.
       - Play-test feedback (2026-11-01): the growth looked like straight links appearing between nodes, from a lattice that covered the board at once. Added a growth phase (`growth.ts`): strands spread from the food (from Tokyo on the Kanto map), fork, and fuse where they meet, over ~9 s; the flow model starts from them with a thin film elsewhere, and the network draws as smoothed curves, never the lattice. Slower rounds (Normal 120 a second). Tour step 3 now uses seed 13; Nine towns' budget is 1.7×.
       - Design pass (2026-11-10): review in `docs/physarum-review.md`; "Design language" in SPEC (field notebook × engineering drawing, after D'Arcy Thompson and Haeckel).
         - Palette: `--phys-*` tokens. The board is a dark petri dish (moss-black agar, rim and grain) with an ochre → chrome-yellow → glow mold, oat-beige flakes, lamp-warm light and drafting-ink reference networks; no cyan.
         - Living tubes: a halo, a body and a core, with shuttle streaming as a slow travelling swell (8 s for about 100 s, labelled). Growing tips are glowing buds.
         - Annotation layer: hand-drawn callouts eased on springs, Plate I–IV captions, figure numbers and a specimen-label readout.
         - Type: serif for the story and the headings.
         - Story-first panel: the hook, then Nature, Try it, Math (MathML equations), Engineering (live cost-against-resilience figure, also on Tokyo) and For the curious (closed). Lens tags appear on every Tour step.
         - New DOM-free `figures.ts`, with tests. The model and the metrics are unchanged.
         - Visual check (2026-11-10, Playwright's Chromium in a temp folder outside the repo, not a dependency). Shots are in `docs/physarum-shots/`: `after-*` from the dev server, and `before-*` from a scratch copy outside the repo with the redesign's visual changes reversed.
         - Fixed after seeing them:
           - the MathML stacked vertically, because CSS `display: block` overrode `display: block math`;
           - the third equation overflowed on phones, so it is now split into two lines;
           - on phones the half sheet left 26 px for reading, so it now snaps higher and hides the readings;
           - phone callouts ran off the board, so small boards get one short note and labels are clamped inside;
           - the callout targets jumped and the leaders fell short;
           - notes collided on two-food boards;
           - Fig. 3 labels overlapped labels and points;
           - the plate caption was truncated on phones and sat on Odawara on Tokyo.
         - Frame rate at 375 × 812 @3×, Metal GPU: 60 fps with p95 frames of 17–19 ms, growing and settled, with and without 4× CPU throttling. That matches the pre-redesign build, so the halo, body and core strokes cost nothing visible.
15. [~] **Home hero v4: News wire on the grid** (careful), SPEC "Home hero v4".
    - Done:
      - the root's links (About, Off the grid, Contact) beside the name, fed from the root, with no section nav;
      - a bigger root;
      - NEWS WIRE in ABOUT ME's place (the top 3 stories plus "All N stories", each story opening its card on `/news`);
      - `/news` in columns (1 / 2 / 4).
    - Verified:
      - `tests/menu.test.ts` (layouts at 10 widths with links, phones, beside and under, circuit with links), all 383 tests, `astro check` and the build;
      - the preview (built site) at 1440×900, 1024×768 and 390×844 with `?motion=reduce`;
      - the home → `/news#s-…` jump.
    - Not verified: the power-on intro and hover springs in a visible window (the preview pane was hidden, so the intro's frames didn't run).
    - v4.1 (2026-10-28):
      - Done:
        - links pushed right, their pills filling the row;
        - bigger headings, a heavier trunk with more current (load weights);
        - NEWS WIRE by category, with the full wire in place on the home page (`#news`, back control, PROJECTS collapsed under it);
        - a story panel on the home page.
      - Verified:
        - 398 tests, `astro check` and the build;
        - the preview (built site) at 1440, 1024 and 390 with `?motion=reduce`: the grid, the full wire, the panel (open, Escape, swap), back and history.
      - Not verified: the drain-and-power-on animation and the panel's spring in a visible window (the pane was hidden).
