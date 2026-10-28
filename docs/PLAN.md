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
