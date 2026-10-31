'use strict';

// Finds the DevTools endpoint TizenBrew opened for its own window and keeps a
// second DevTools session attached to it, so the service can drive the page
// with trusted input events, capture the screen and handle JS dialogs.

const fs = require('fs');
const http = require('http');
const urlLib = require('url');
const EventEmitter = require('events').EventEmitter;
const ws = require('./ws');
const log = require('./log');

// Ports we know are not the inspector: Samsung remote API, TizenBrew,
// TizenTube, sdb.
const SKIP_PORTS = [8001, 8002, 8081, 8085, 8095, 8099, 26101];

function hexToIpv4(hex) {
    // /proc/net/tcp stores IPv4 addresses little-endian.
    return [6, 4, 2, 0].map((i) => parseInt(hex.substr(i, 2), 16)).join('.');
}

function parseProcNet(text, isV6) {
    const result = [];
    text.split('\n').slice(1).forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts[3] !== '0A') return; // 0A = LISTEN
        const local = parts[1].split(':');
        const port = parseInt(local[1], 16);
        let ip;
        if (!isV6) {
            ip = hexToIpv4(local[0]);
        } else if (/^0{32}$/.test(local[0])) {
            ip = '0.0.0.0';
        } else if (/^0{16}FFFF0000/i.test(local[0])) {
            ip = hexToIpv4(local[0].substr(24));
        } else if (local[0] === '00000000000000000000000001000000') {
            ip = '127.0.0.1';
        } else {
            return;
        }
        result.push({ ip: ip, port: port });
    });
    return result;
}

function listeningSockets() {
    let list = [];
    [['/proc/net/tcp', false], ['/proc/net/tcp6', true]].forEach((entry) => {
        try {
            list = list.concat(parseProcNet(fs.readFileSync(entry[0], 'utf8'), entry[1]));
        } catch (e) { /* not Linux, or not readable */ }
    });
    return list;
}

function httpJson(host, port, path, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: host, port: port, path: path }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        });
        req.setTimeout(timeoutMs, () => req.abort());
        req.on('error', reject);
    });
}

function listTargets(host, port) {
    return httpJson(host, port, '/json/list', 800)
        .catch(() => httpJson(host, port, '/json', 800))
        .then((targets) => {
            if (!Array.isArray(targets)) throw new Error('Not a DevTools endpoint');
            return targets;
        });
}

function defaultPickTarget(targets) {
    const pages = targets.filter((t) => t.type === 'page' && !/^(devtools|chrome-extension):/.test(t.url || ''));
    return pages[0] || null;
}

class Cdp extends EventEmitter {
    constructor(options) {
        super();
        this.ownPort = options.ownPort;
        this.fixedEndpoints = options.endpoints || null;
        this.pickTarget = options.pickTarget || defaultPickTarget;
        this.listSockets = options.listSockets || listeningSockets;
        this.attached = false;
        this.endpoint = null;
        this.lastError = null;
        this.scans = 0;
        this._conn = null;
        this._nextId = 1;
        this._pending = {};
        this._scanTimer = null;
        this._scanning = false;
    }

    start() {
        this._scheduleScan(0);
    }

    _scheduleScan(delay) {
        clearTimeout(this._scanTimer);
        this._scanTimer = setTimeout(() => this._scan(), delay);
    }

    _candidates() {
        if (this.fixedEndpoints) return this.fixedEndpoints.slice();
        const seen = {};
        const out = [];
        this.listSockets().forEach((s) => {
            if (s.port < 1024 || s.port === this.ownPort || SKIP_PORTS.indexOf(s.port) !== -1) return;
            const host = s.ip === '0.0.0.0' ? '127.0.0.1' : s.ip;
            const key = host + ':' + s.port;
            if (seen[key]) return;
            seen[key] = true;
            out.push({ host: host, port: s.port });
        });
        return out;
    }

    _scan() {
        if (this.attached || this._scanning) return;
        this._scanning = true;
        this.scans++;
        const candidates = this._candidates();
        const probes = candidates.map((c) => listTargets(c.host, c.port)
            .then((targets) => ({ host: c.host, port: c.port, targets: targets }))
            .catch(() => null));

        Promise.all(probes).then((results) => {
            this._scanning = false;
            const found = results.filter(Boolean);
            for (let i = 0; i < found.length; i++) {
                const target = this.pickTarget(found[i].targets);
                if (target) return this._attach(found[i].host, found[i].port, target);
            }
            this.lastError = candidates.length
                ? 'No DevTools endpoint among ' + candidates.length + ' listening ports'
                : 'No listening ports found';
            this._scheduleScan(Math.min(10000, 2000 + this.scans * 500));
        });
    }

    _attach(host, port, target) {
        // Chromium < 63 hides webSocketDebuggerUrl while another client is
        // attached; try the conventional path anyway.
        let path = '/devtools/page/' + target.id;
        if (target.webSocketDebuggerUrl) path = urlLib.parse(target.webSocketDebuggerUrl).path;
        const wsUrl = 'ws://' + host + ':' + port + path;
        ws.connect(wsUrl, (err, conn) => {
            if (err) {
                this.lastError = 'Attach failed: ' + err.message;
                log.warn('DevTools attach to', host + ':' + port, 'failed:', err.message);
                return this._scheduleScan(5000);
            }
            this._conn = conn;
            this.attached = true;
            this.endpoint = host + ':' + port;
            this.lastError = null;
            log.info('DevTools attached at', this.endpoint, '(' + (target.title || target.url || target.id) + ')');
            conn.on('message', (text) => this._onMessage(text));
            conn.on('close', () => this._onClose());
            this.send('Page.enable').then(() => this.emit('attached')).catch((e) => {
                log.warn('Page.enable failed:', e.message);
                this.emit('attached');
            });
        });
    }

    _onMessage(text) {
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (msg.id) {
            const pending = this._pending[msg.id];
            if (!pending) return;
            delete this._pending[msg.id];
            clearTimeout(pending.timer);
            if (msg.error) pending.reject(new Error(msg.error.message || 'DevTools error'));
            else pending.resolve(msg.result || {});
        } else if (msg.method) {
            this.emit(msg.method, msg.params || {});
        }
    }

    _onClose() {
        if (!this.attached) return;
        this.attached = false;
        this._conn = null;
        this.lastError = 'DevTools connection closed';
        log.warn('DevTools connection closed');
        Object.keys(this._pending).forEach((id) => {
            clearTimeout(this._pending[id].timer);
            this._pending[id].reject(new Error('DevTools connection closed'));
        });
        this._pending = {};
        this.emit('detached');
        this._scheduleScan(1500);
    }

    send(method, params, timeoutMs) {
        if (!this.attached || !this._conn) return Promise.reject(new Error('DevTools not attached'));
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this._pending[id];
                reject(new Error(method + ' timed out'));
            }, timeoutMs || 8000);
            this._pending[id] = { resolve: resolve, reject: reject, timer: timer };
            this._conn.send(JSON.stringify({ id: id, method: method, params: params || {} }));
        });
    }

    evaluate(expression, userGesture) {
        return this.send('Runtime.evaluate', {
            expression: expression,
            returnByValue: true,
            userGesture: !!userGesture
        }).then((r) => {
            if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
            return r.result ? r.result.value : undefined;
        });
    }
}

module.exports = { Cdp, parseProcNet };
