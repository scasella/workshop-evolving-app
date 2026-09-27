import { Host } from '../src/host/store.ts';
import { runQueued, simulatedReviewer } from '../src/host/runner.ts';
// Crash injection: the risk review's model call is "in flight" when the process dies.
const [dir] = process.argv.slice(2);
const host = new Host(dir);
await runQueued(host, { kind: 'simulated', async review(bundle, signal) {
  if (bundle.obligation.id.endsWith('-risk')) { await new Promise(r => setTimeout(r, 30)); process.exit(137); }
  return simulatedReviewer.review(bundle, signal);
} }, { root: 'root-p2', concurrency: 2 });
process.exit(0);
