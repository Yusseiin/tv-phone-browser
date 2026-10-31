'use strict';

// Buffer.from/Buffer.alloc only exist from Node 4.5; Tizen 3 TVs ship 4.4.3.
// (Checking Buffer.alloc rather than Buffer.from: before 4.5, Buffer.from is
// inherited from Uint8Array.from and behaves differently.)
const modern = typeof Buffer.alloc === 'function';

function from(data, encoding) {
    return modern ? Buffer.from(data, encoding) : new Buffer(data, encoding);
}

function alloc(size) {
    if (modern) return Buffer.alloc(size);
    const b = new Buffer(size);
    b.fill(0);
    return b;
}

module.exports = { from, alloc };
