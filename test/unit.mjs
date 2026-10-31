// Unit tests for the TV-side DevTools discovery (the part that reads
// /proc/net/tcp on the TV, which can't run on a Mac).
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchChrome, startPages, CHROME_PORT, PAGES_PORT } from './tv-sim.mjs';

const require = createRequire(import.meta.url);
const { Cdp, parseProcNet } = require('../src/service/cdp.js');

const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  5001        0 1 1
   1: 0100007F:2475 00000000:0000 0A 00000000:00000000 00:00000000 00000000  5001        0 2 1
   2: 3201A8C0:9C41 00000000:0000 0A 00000000:00000000 00:00000000 00000000  5001        0 3 1
   3: 0100007F:1F91 0100007F:C350 01 00000000:00000000 00:00000000 00000000  5001        0 4 1
`;
const tcp6 = `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000000000000:1F41 00000000000000000000000000000000:0000 0A
   1: 0000000000000000FFFF00003201A8C0:2329 00000000000000000000000000000000:0000 0A
   2: 20010DB8000000000000000000000001:0050 00000000000000000000000000000000:0000 0A
`;

assert.deepEqual(parseProcNet(tcp, false), [
    { ip: '0.0.0.0', port: 8765 },
    { ip: '127.0.0.1', port: 9333 },
    { ip: '192.168.1.50', port: 40001 }
], 'IPv4 listeners (established sockets ignored)');
assert.deepEqual(parseProcNet(tcp6, true), [
    { ip: '0.0.0.0', port: 8001 },
    { ip: '192.168.1.50', port: 9001 }
], 'IPv6 any + v4-mapped, other IPv6 skipped');
console.log('  ok    /proc/net/tcp parsing');

// Discovery against real ports: our own port and Samsung's are skipped, a
// non-DevTools HTTP server is rejected, Chrome's inspector is found.
const chrome = await launchChrome(path.join(os.tmpdir(), 'tvr-chrome-unit'));
const pages = await startPages();
const cdp = new Cdp({
    ownPort: 8765,
    listSockets: () => [
        { ip: '0.0.0.0', port: 8765 },
        { ip: '0.0.0.0', port: 8001 },
        { ip: '127.0.0.1', port: PAGES_PORT },
        { ip: '0.0.0.0', port: 1 },
        { ip: '127.0.0.1', port: CHROME_PORT }
    ]
});
const candidates = cdp._candidates().map((c) => c.host + ':' + c.port);
assert.deepEqual(candidates, [`127.0.0.1:${PAGES_PORT}`, `127.0.0.1:${CHROME_PORT}`], 'candidate filtering');
console.log('  ok    candidate ports filtered');

await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not attach')), 8000);
    cdp.on('attached', () => { clearTimeout(timer); resolve(); });
    cdp.start();
});
assert.equal(cdp.endpoint, `127.0.0.1:${CHROME_PORT}`);
assert.equal(await cdp.evaluate('1 + 1'), 2);
console.log('  ok    discovers and attaches to the DevTools port');

chrome.kill();
pages.close();
setTimeout(() => process.exit(0), 100);
