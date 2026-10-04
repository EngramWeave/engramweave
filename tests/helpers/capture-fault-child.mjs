import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const stopAt = process.argv[3];
const originalLink = fs.link;
const gate = async phase => {
  if (phase !== stopAt) return;
  const released = new Promise(resolve => process.once('message', resolve));
  process.send({ phase });
  await released;
};
// Instrument only this owned test process; the product has no fault-injection switches.
fs.link = async (...args) => {
  if (!path.basename(String(args[0])).startsWith('.engramweave-capture-')) return originalLink(...args);
  await gate('before_publish');
  const result = await originalLink(...args);
  await gate('after_publish');
  return result;
};
syncBuiltinESMExports();
const { startCore } = await import('../../packages/core/dist/main.js');
await startCore(config);
process.send({ phase: 'core_ready' });
