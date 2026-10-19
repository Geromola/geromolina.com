# Site copy (draft — Gero reviews before deploy)

Sources: the vault's Positioning Statements, Education and Publications, PROJ-02 and PROJ-05, and the repo READMEs. Every claim below appears in those sources. Lines marked ⚑ are interpretations Gero should confirm.

## Hero
- Kicker: `Geronimo Molina · Berkeley Haas MBA + MEng`
- Name: `Gero`
- Line: "Energy nerd who builds things. Place transformers, power the grid."

## About
> Hi, I'm Gero. I'm a chemical engineer who spent four years at Mastercard Advisors building digital-payments programs across Latin America. Now I'm at Berkeley doing an MBA at Haas and an MEng in materials science at the same time, pointing all of it at the energy transition. ⚑
>
> On the side, I build small, honest tools. One is a language model I trained from scratch and then made sit an exam. Another is a team of AI agents that read 660,622 app reviews and had to show its work. And there's this grid, which you may have just lost a few megawatts on. I like problems where the physics or the data gets the final word.

## Off the grid
- **Regional Muay Thai champion**, at 16.
- **Founded a cycling team**: Mastercard Advisors' first regional one.
- **Published in the ACS Journal of Chemical Education**: LEDs as voltage generators, with homemade solar electrolysis (2021). Link: https://doi.org/10.1021/acs.jchemed.1c00093
- **Taught STEM to 250+ at-risk students** through a digital course I built as a volunteer.

## My tools (locked tile)
- Title: Networking Tracker
- Line: "Where I keep track of the people I meet. Mine only, so it'll ask you to sign in."

## Contact
- Heading: "Plug in"
- Line: "Building something in energy or AI, or just want to compare notes? Say hi."
- Links: hi@geromolina.com · LinkedIn · GitHub

## Project: Custom LLM (`custom-llm`)
- **Pitch:** "A 122,368-parameter language model I trained from scratch, then made sit a 48-question exam. The explorer runs the real weights in your browser, so you can watch it think."
- **Metrics:**
  - `122K` parameters
  - `20 → 35` of 48 on the exam
  - `0 / 12` on the control questions, every run
- **How it works:** A nanoGPT-style model (2 blocks, 4 attention heads, 64 dimensions) trained in PyTorch on a corpus I generated. The question was simple: does extra study material actually teach it anything? I committed my predictions to git before training, ran three seeds, and audited the train/test split six ways. The score rose from 20 to 35 out of 48. All of the gain came from the categories the new material taught, and the control questions stayed at zero. The explorer shows the embeddings, the attention and the next-token probabilities as they happen.

## Project: Spotify Insight (`spotify-insight`)
- **Pitch:** "A team of AI agents read all 660,622 Spotify app reviews and argued their way to one product priority. Every number on the dashboard traces back to evidence."
- **Metrics:**
  - `660,622` reviews, none missing
  - `$7.94` for the full run
  - `94%` topic accuracy on a hand-labelled set
- **How it works:**
  - An enricher agent (Claude Haiku, in batches) classifies every review by topic, intent, severity and free versus paid tier.
  - A blind verifier agent re-checks a 1,000-review sample. It caught 20 of 20 planted errors.
  - A grouper builds the issue taxonomy, and a diagnosis agent maps every complaint to one of 31 concrete symptoms.
  - A memo writer drafts the recommendation, and code checks every number and quote before a critic agent signs off.
  - The verdict: fix playback first. Crashes and music that stops on its own lead every lens.
  - The dashboard reads from Postgres and makes no model calls, so it's cheap to keep online.
- Built for Fundamentals of Agentic AI, Berkeley Haas, Fall 2026.

## 404
- Title: "Power outage"
- Line: "This page tripped a breaker. Let's get you back on the grid." Button: "Back home"
