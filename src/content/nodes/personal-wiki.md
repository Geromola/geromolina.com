---
id: personal-wiki
kind: plant
status: code
inGame: false
title: Personal Wiki
kicker: Code · open source
href: /projects/personal-wiki
land: [0.5, 0.5]
port: [0.5, 0.5]
order: 6
pitch: 'An offline AI research assistant over my own energy research and class notes. It answers with cited sources, and nothing ever leaves my laptop.'
repo: https://github.com/Geromola/personal-wiki
embed: false
metrics:
  - { value: '8 / 8', label: 'cited-answer tests passed' }
  - { value: '685', label: 'passages indexed' }
  - { value: '4.5–9.6 s', label: 'per answer, fully offline' }
---

A local Gemma model (4-bit, MLX) runs on Apple Silicon and loads from local files only. Retrieval is hybrid: BM25 keyword search plus bge-small embeddings, merged with reciprocal rank fusion. It indexes 41 of my notes into 685 passages and generates 60 linked wiki pages across 7 topics. I wrote 8 offline tests (cited answers and correct refusals) and iterated 8 times until all passed. The failures got fixed by better retrieval, not a bigger model. Offline operation is verified by blocking all network access.
