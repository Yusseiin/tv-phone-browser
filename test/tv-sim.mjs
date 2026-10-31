// Local stand-in for the TV: runs dist/service.js in the same kind of vm
// sandbox TizenBrew uses, serves test pages, and drives a headless Chrome that
// plays the part of the TizenBrew window.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ws = require('../src/service/ws.js');
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE_PORT = 8765;
export const PAGES_PORT = 8766;
export const CHROME_PORT = 9333;

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function startService(config) {
    // Mirrors tizenbrew-app/.../utils/serviceLauncher.js.
    const sandbox = {};
    const disallowed = ['services', 'module', 'global', 'globalThis', 'inDebug', 'currentClient', 'currentModule'];
    Object.getOwnPropertyNames(globalThis).forEach((prop) => {
        if (disallowed.includes(prop)) return;
        sandbox[prop] = globalThis[prop];
    });
    sandbox.require = require;
    sandbox.module = { exports: {} };
    sandbox.tizen = {
        systeminfo: {
            getCapability: (key) => (key.includes('platform.version') ? '6.0' : 'SIMULATOR'),
            getPropertyValue: (prop, ok, err) => err && err(new Error('not available'))
        },
        application: {
            getAppInfo: () => ({ packageId: 'xvvl3S1bvH' }),
            getCurrentApplication: () => ({ exit() {} })
        }
    };
    sandbox.TVR_CONFIG = config;
    const code = fs.readFileSync(path.join(root, 'dist/service.js'), 'utf8');
    vm.runInContext(code, vm.createContext(sandbox), { filename: 'service.js' });
}

// Serves test/pages. csp.html is sent with a strict Content-Security-Policy
// that blocks the agent's WebSocket, like some real sites do.
export function startPages() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const name = url.pathname === '/csp.html' ? '/test.html' : url.pathname;
        const file = path.join(root, 'test/pages', path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
        fs.readFile(file, 'utf8', (err, body) => {
            if (err) {
                res.writeHead(404);
                return res.end('not found');
            }
            const headers = { 'Content-Type': 'text/html; charset=utf-8' };
            if (url.pathname === '/csp.html') {
                headers['Content-Security-Policy'] = "default-src 'self' 'unsafe-inline'; connect-src 'self'";
                body = body.replace('<title>Test page</title>', '<title>CSP page</title>');
            }
            res.writeHead(200, headers);
            res.end(body);
        });
    });
    return new Promise((resolve) => server.listen(PAGES_PORT, '127.0.0.1', () => resolve(server)));
}

export const MENU_URL = `http://127.0.0.1:${PAGES_PORT}/tizenbrew-ui/dist/index.html`;

// The TV window starts on TizenBrew's menu (startUrl); launching Phone Browser
// from it navigates to about:blank.
export async function launchChrome(profileDir, startUrl = 'about:blank') {
    fs.rmSync(profileDir, { recursive: true, force: true });
    const proc = spawn(CHROME, [
        '--headless=new',
        `--remote-debugging-port=${CHROME_PORT}`,
        `--user-data-dir=${profileDir}`,
        '--window-size=1920,1080',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        startUrl
    ], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
        try {
            await getJson(`http://127.0.0.1:${CHROME_PORT}/json/version`);
            return proc;
        } catch (e) {
            await sleep(200);
        }
    }
    proc.kill();
    throw new Error('Chrome did not start');
}

export function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

export function postJson(url, data) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(data || {}));
    });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(url) {
    return new Promise((resolve, reject) => ws.connect(url, (err, conn) => (err ? reject(err) : resolve(conn))));
}

// A second DevTools client used by the tests to look inside the "TV" page.
// With tizenBrew: true it also injects dist/agent.js into every new JS
// context, exactly like TizenBrew's service/utils/debugger.js does while
// Phone Browser is the launched module. Set `injectAgent = false` to play
// another TizenBrew app being open.
export async function inspector(options = {}) {
    const targets = await getJson(`http://127.0.0.1:${CHROME_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    const conn = await wsConnect(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const send = (method, params) => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
        conn.send(JSON.stringify({ id: msgId, method, params: params || {} }));
    });
    const agentSource = fs.readFileSync(path.join(root, 'dist/agent.js'), 'utf8');
    let client = null;
    conn.on('message', (text) => {
        const msg = JSON.parse(text);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === 'Runtime.executionContextCreated' && options.tizenBrew && (!client || client.injectAgent)) {
            send('Runtime.evaluate', { expression: agentSource, contextId: msg.params.context.id }).catch(() => {});
        }
    });
    if (options.tizenBrew) {
        await send('Runtime.enable');
        await send('Debugger.enable');
    }
    client = {
        injectAgent: true,
        send,
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression, returnByValue: true });
            return r.result.value;
        },
        // What TizenBrew does when you pick Phone Browser in its menu: the
        // menu page itself sets location.href (so about:blank inherits its
        // origin, which matters to Chrome's local-network checks).
        async launchPhoneBrowser() {
            if (!(await client.eval('location.pathname')).includes('/tizenbrew-ui/')) {
                await send('Page.navigate', { url: MENU_URL });
                await waitFor(async () => (await client.eval('location.pathname')).includes('/tizenbrew-ui/'), 'TizenBrew menu');
            }
            client.injectAgent = true;
            await send('Runtime.evaluate', { expression: "location.href = 'about:blank'" });
        },
        close: () => conn.close()
    };
    return client;
}

// The phone side of the protocol.
export async function phone(token) {
    const conn = await wsConnect(`ws://127.0.0.1:${SERVICE_PORT}/ws?token=${token}`);
    const client = {
        state: null,
        messages: [],
        closedCode: null,
        send: (msg) => conn.send(JSON.stringify(msg)),
        close: () => conn.close()
    };
    conn.on('message', (text) => {
        const msg = JSON.parse(text);
        client.messages.push(msg);
        if (msg.t === 'state') client.state = msg;
    });
    conn.on('close', () => { client.closedCode = client.closedCode || 'closed'; });
    return client;
}

export async function waitFor(fn, what, timeoutMs = 6000) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeoutMs) {
        try {
            last = await fn();
            if (last) return last;
        } catch (e) {
            last = e.message;
        }
        await sleep(80);
    }
    throw new Error(`Timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}
