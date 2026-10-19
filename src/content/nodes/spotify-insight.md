---
id: spotify-insight
kind: plant
title: Spotify Insight
kicker: Plant · live
href: /projects/spotify-insight
land: [0.84, 0.22]
port: [0.74, 0.47]
order: 1
pitch: 'A team of AI agents read all 660,622 Spotify app reviews and argued their way to one product priority. Every number on the dashboard traces back to evidence.'
liveUrl: https://spotify-insight-dashboard-seven.vercel.app
repo: https://github.com/Geromola/spotify-insight-pipeline
embed: true
metrics:
  - { value: '660,622', label: 'reviews, none missing' }
  - { value: '$7.94', label: 'for the full run' }
  - { value: '94%', label: 'topic accuracy on a hand-labelled set' }
---

- An enricher agent (Claude Haiku, in batches) classifies every review by topic, intent, severity and free versus paid tier.
- A blind verifier agent re-checks a 1,000-review sample. It caught 20 of 20 planted errors.
- A grouper builds the issue taxonomy, and a diagnosis agent maps every complaint to one of 31 concrete symptoms.
- A memo writer drafts the recommendation, and code checks every number and quote before a critic agent signs off.
- The verdict: fix playback first. Crashes and music that stops on its own lead every lens.
- The dashboard reads from Postgres and makes no model calls, so it's cheap to keep online.

Built for Fundamentals of Agentic AI, Berkeley Haas, Fall 2026.
