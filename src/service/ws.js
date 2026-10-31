'use strict';

// Minimal RFC 6455 WebSocket (server + client), dependency-free so it runs on
// the Node.js versions shipped with Tizen (as old as v4.4.3).

const crypto = require('crypto');
const http = require('http');
const urlLib = require('url');
const EventEmitter = require('events').EventEmitter;
const buf = require('./buf');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 32 * 1024 * 1024;

function acceptKey(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WsConnection extends EventEmitter {
    constructor(socket, isClient) {
        super();
        this.socket = socket;
        this.isClient = isClient;
        this.open = true;
        this._buf = buf.alloc(0);
        this._fragments = null;
        this._fragmentOpcode = 0;
        this._lastSeen = Date.now();
        this._closed = false;

        socket.setNoDelay(true);
        socket.on('data', (data) => this._onData(data));
        socket.on('error', (err) => this._finish(err));
        socket.on('close', () => this._finish());
        socket.on('end', () => this._finish());

        if (!isClient) {
            // Detect phones that went to sleep without closing the socket.
            this._pingTimer = setInterval(() => {
                if (Date.now() - this._lastSeen > 45000) return this.terminate();
                this._frame(0x9, buf.alloc(0));
            }, 20000);
        }
    }

    send(text) {
        if (!this.open) return false;
        this._frame(0x1, buf.from(String(text), 'utf8'));
        return true;
    }

    close(code, reason) {
        if (!this.open) return;
        const reasonBuf = buf.from(reason || '', 'utf8');
        const payload = buf.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code || 1000, 0);
        reasonBuf.copy(payload, 2);
        this._frame(0x8, payload);
        this.open = false;
        setTimeout(() => this.terminate(), 1000);
    }

    terminate() {
        try { this.socket.destroy(); } catch (e) { /* already gone */ }
        this._finish();
    }

    _finish(err) {
        if (this._closed) return;
        this._closed = true;
        this.open = false;
        clearInterval(this._pingTimer);
        this.emit('close', err);
    }

    _frame(opcode, payload) {
        if (this._closed) return;
        const len = payload.length;
        let headerLen = len < 126 ? 2 : (len < 65536 ? 4 : 10);
        const maskLen = this.isClient ? 4 : 0;
        const header = buf.alloc(headerLen + maskLen);
        header[0] = 0x80 | opcode;
        if (len < 126) {
            header[1] = len;
        } else if (len < 65536) {
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header[1] = 127;
            header.writeUInt32BE(Math.floor(len / 4294967296), 2);
            header.writeUInt32BE(len % 4294967296, 6);
        }
        let body = payload;
        if (this.isClient) {
            header[1] |= 0x80;
            const mask = crypto.randomBytes(4);
            mask.copy(header, headerLen);
            body = buf.alloc(len);
            for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
        }
        try {
            this.socket.write(Buffer.concat([header, body]));
        } catch (e) {
            this._finish(e);
        }
    }

    // Bytes that arrived together with the handshake. Parse them on the next
    // tick so the caller can attach 'message' listeners first; later socket
    // data is appended behind them, keeping the order.
    _prime(head) {
        if (!head || !head.length) return;
        this._buf = head;
        setImmediate(() => this._onData(buf.alloc(0)));
    }

    _onData(data) {
        this._lastSeen = Date.now();
        this._buf = this._buf.length ? Buffer.concat([this._buf, data]) : data;
        while (this._parseFrame()) { /* keep parsing */ }
    }

    _parseFrame() {
        const b = this._buf;
        if (b.length < 2) return false;
        const fin = (b[0] & 0x80) !== 0;
        const opcode = b[0] & 0x0f;
        const masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
            if (b.length < 4) return false;
            len = b.readUInt16BE(2);
            offset = 4;
        } else if (len === 127) {
            if (b.length < 10) return false;
            len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6);
            offset = 10;
        }
        if (len > MAX_PAYLOAD) {
            this.close(1009, 'Message too big');
            this._buf = buf.alloc(0);
            return false;
        }
        let mask = null;
        if (masked) {
            if (b.length < offset + 4) return false;
            mask = b.slice(offset, offset + 4);
            offset += 4;
        }
        if (b.length < offset + len) return false;

        let payload = b.slice(offset, offset + len);
        if (mask) {
            const unmasked = buf.alloc(len);
            for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
            payload = unmasked;
        }
        this._buf = b.slice(offset + len);
        this._handleFrame(fin, opcode, payload);
        return true;
    }

    _handleFrame(fin, opcode, payload) {
        switch (opcode) {
            case 0x0: // continuation
                if (!this._fragments) return;
                this._fragments.push(payload);
                if (fin) {
                    const whole = Buffer.concat(this._fragments);
                    this._fragments = null;
                    this._emitMessage(this._fragmentOpcode, whole);
                }
                break;
            case 0x1:
            case 0x2:
                if (fin) {
                    this._emitMessage(opcode, payload);
                } else {
                    this._fragments = [payload];
                    this._fragmentOpcode = opcode;
                }
                break;
            case 0x8: // close
                if (this.open) {
                    this._frame(0x8, payload.length >= 2 ? payload.slice(0, 2) : buf.alloc(0));
                    this.open = false;
                }
                this.terminate();
                break;
            case 0x9: // ping
                this._frame(0xA, payload);
                break;
            default: // pong and anything unknown
                break;
        }
    }

    _emitMessage(opcode, payload) {
        this.emit('message', opcode === 0x1 ? payload.toString('utf8') : payload);
    }
}

// Server side: complete the HTTP upgrade and wrap the socket.
function acceptUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return null;
    }
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    const conn = new WsConnection(socket, false);
    conn._prime(head);
    return conn;
}

// Client side: used to talk to Chromium's DevTools endpoint.
function connect(wsUrl, callback) {
    const parsed = urlLib.parse(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    let done = false;
    function finish(err, conn) {
        if (done) return;
        done = true;
        callback(err, conn);
    }
    const req = http.request({
        host: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.path,
        headers: {
            'Connection': 'Upgrade',
            'Upgrade': 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': key
        }
    });
    req.setTimeout(5000, () => {
        req.abort();
        finish(new Error('WebSocket connect timeout'));
    });
    req.on('upgrade', (res, socket, head) => {
        if (res.headers['sec-websocket-accept'] !== acceptKey(key)) {
            socket.destroy();
            return finish(new Error('Bad WebSocket accept header'));
        }
        socket.setTimeout(0);
        const conn = new WsConnection(socket, true);
        conn._prime(head);
        finish(null, conn);
    });
    req.on('response', (res) => {
        res.resume();
        finish(new Error('WebSocket upgrade refused: HTTP ' + res.statusCode));
    });
    req.on('error', (err) => finish(err));
    req.end();
}

module.exports = { acceptUpgrade, connect, WsConnection };
