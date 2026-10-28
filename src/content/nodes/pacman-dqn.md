---
id: pacman-dqn
kind: plant
status: code
inGame: false
title: Pac-Man DQN
kicker: Code · open source
href: /projects/pacman-dqn
land: [0.5, 0.5]
port: [0.5, 0.5]
order: 0
category: games
tags: ['Reinforcement learning']
pitch: 'An agent that learned Ms. Pac-Man from raw pixels, and more than tripled its score.'
repo: https://github.com/Geromola/pacman-dqn
embed: false
metrics:
  - { value: '1,668', label: 'mean score, vs 492 untrained' }
  - { value: '5 / 5', label: 'evaluation seeds improved' }
  - { value: '2.36M', label: 'decisions trained in 112 min' }
---

The agent sees four 84×84 grayscale frames and picks one of 9 moves. Starting from a course notebook, I added Double DQN, 3-step returns, a life-loss signal and a 100,000-frame replay buffer stored 5× more compactly. A baseline run (1,000 episodes) and a tuned run (3,000 episodes) were compared, with checkpoints picked on separate validation seeds.
