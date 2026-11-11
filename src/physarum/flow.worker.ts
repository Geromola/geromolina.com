/// <reference lib="webworker" />
/**
 * Runs the Physarum flow model off the main thread (SPEC "Physarum"). Steps the FlowRunner in
 * slices of a few milliseconds and posts a state about 15 times a second, and once at once
 * after anything that changes the network.
 */
import { FlowRunner, type FromRunner, type ToRunner } from './runner';

const runner = new FlowRunner();
const SLICE_MS = 10;
const POST_MS = 66;
let last = performance.now();
let lastPost = 0;
let timer = 0;

const post = (msg: FromRunner) => {
  if (msg.type === 'state') (self as DedicatedWorkerGlobalScope).postMessage(msg, [msg.D.buffer, msg.inNet.buffer]);
  else (self as DedicatedWorkerGlobalScope).postMessage(msg);
};

function postState() {
  const s = runner.state();
  if (s) post(s);
  lastPost = performance.now();
}

function loop() {
  timer = 0;
  const now = performance.now();
  const stepped = runner.tick((now - last) / 1000, SLICE_MS);
  last = now;
  const grown = runner.takeGrowth();
  if (grown) post(grown);
  if (stepped && now - lastPost > POST_MS) postState();
  if (runner.running) timer = self.setTimeout(loop, 4);
}

self.onmessage = (e: MessageEvent<ToRunner>) => {
  const mesh = runner.handle(e.data);
  if (mesh) post(mesh);
  const grown = runner.takeGrowth();
  if (grown) post(grown);
  if (e.data.type !== 'run' || !runner.running) postState();
  last = performance.now();
  if (runner.running && !timer) loop();
};
