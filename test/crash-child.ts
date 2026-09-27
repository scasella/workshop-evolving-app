import { Host } from '../src/host/store.ts';
// Child process for crash injection: exits abruptly inside or just after the activation transaction.
const [dir, proposal, mode] = process.argv.slice(2);
const host = new Host(dir);
if (mode === 'before') host.faults.beforeActivationCommit = () => process.exit(137);
else host.faults.afterActivationCommit = () => process.exit(138);
host.activate(proposal);
process.exit(0);
