---
id: custom-llm
kind: plant
status: live
title: Custom LLM
kicker: Plant · live
href: /projects/custom-llm
land: [0.56, 0.3]
port: [0.36, 0.33]
order: 1
category: solutions
tags: ['From scratch', 'Berkeley']
pitch: 'A 122,368-parameter language model I trained from scratch, then made sit a 48-question exam. The explorer runs the real weights in your browser, so you can watch it think.'
liveUrl: https://geromola.github.io/custom-llm/viz/
repo: https://github.com/Geromola/custom-llm
embed: true
metrics:
  - { value: '122K', label: 'parameters' }
  - { value: '20 → 35', label: 'of 48 on the exam' }
  - { value: '0 / 12', label: 'on the control questions, every run' }
---

A nanoGPT-style model (2 blocks, 4 attention heads, 64 dimensions) trained in PyTorch on a corpus I generated. The question was simple: does extra study material actually teach it anything? I committed my predictions to git before training, ran three seeds, and audited the train/test split six ways. The score rose from 20 to 35 out of 48. All of the gain came from the categories the new material taught, and the control questions stayed at zero. The explorer shows the embeddings, the attention and the next-token probabilities as they happen.
