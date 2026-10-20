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
6. [~] **Charge-up and view transitions** (careful), after 3 and 5.
7. [x] **PWA, sitemap, OG, analytics** (light), after 5.
8. [ ] **Phone, a11y and perf pass** (careful), after 3, 4 and 6.
9. [ ] Deploy. The orchestrator does this, confirming each outward step with Gero: push to GitHub, import into Vercel, set up Cloudflare DNS (DNS only), enable Analytics.
