// Interactive dev setup without a TV:
//   - headless Chrome plays the TizenBrew window (agent injected like TizenBrew does)
//   - the service runs in a TizenBrew-style sandbox with DevTools access
//   - http://127.0.0.1:8767 shows what the "TV" displays
//   - http://<this machine>:8765 is the phone remote
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { root, startService, startPages, launchChrome, inspector, CHROME_PORT, SERVICE_PORT, MENU_URL } from './tv-sim.mjs';

const VIEWER_PORT = 8767;

await startPages();
const chrome = await launchChrome(path.join(os.tmpdir(), 'tvr-chrome-dev'), MENU_URL);
startService({
    dataFile: path.join(root, 'test/.data/store-dev.json'),
    cdpEndpoints: [{ host: '127.0.0.1', port: CHROME_PORT }]
});
const tv = await inspector({ tizenBrew: true });
await tv.launchPhoneBrowser();

http.createServer(async (req, res) => {
    if (req.url.startsWith('/tv.jpg')) {
        try {
            const shot = await tv.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
            return res.end(Buffer.from(shot.data, 'base64'));
        } catch (e) {
            res.writeHead(500);
            return res.end(e.message);
        }
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>TV</title><body style="margin:0;background:#000;display:grid;place-items:center;height:100vh">
<img id="tv" style="max-width:100%;max-height:100vh" src="/tv.jpg">
<script>const img=document.getElementById('tv');img.onload=img.onerror=()=>setTimeout(()=>img.src='/tv.jpg?'+Date.now(),400);</script>`);
}).listen(VIEWER_PORT, '127.0.0.1');

console.log(`TV view:      http://127.0.0.1:${VIEWER_PORT}`);
console.log(`Phone remote: http://127.0.0.1:${SERVICE_PORT}  (or this machine's LAN IP from a real phone)`);
process.on('SIGINT', () => { chrome.kill(); process.exit(0); });
process.on('SIGTERM', () => { chrome.kill(); process.exit(0); });
