import { open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Exercise only the D07 native primitive. Capture parsing, HTTP and replay are T09.
const [directory, encoded, stopAt] = process.argv.slice(2);
const bytes = Buffer.from(encoded, 'base64');
const temporary = path.join(directory, `.engramweave-${randomUUID()}.tmp`);
const target = path.join(directory, 'published.md');
const gate = async phase => {
  const wait = phase === stopAt || (phase === 'flushed' && stopAt === 'race');
  const released = wait ? new Promise(resolve => process.once('message', resolve)) : null;
  process.send({ phase, temporary, target });
  if (released) await released;
};
const handle = await open(temporary, 'wx');
await handle.writeFile(bytes.subarray(0, Math.floor(bytes.length / 2)));
await gate('partial');
await handle.writeFile(bytes.subarray(Math.floor(bytes.length / 2)));
await handle.sync();
await handle.close();
await gate('flushed');
let outcome = 'created';
try { await link(temporary, target); await gate('linked'); }
catch (error) { outcome = error.code; }
await unlink(temporary);
await gate('cleaned');
process.send({ phase: 'done', outcome, temporary, target });
setInterval(() => {}, 1000);
