'use strict';

// Ring buffer of recent log lines, readable from the phone's Diagnostics panel
// (TizenBrew services have no visible console on the TV).

const MAX_LINES = 200;
const lines = [];

function write(level, args) {
    const text = Array.prototype.map.call(args, (a) => {
        // No instanceof: errors from Node internals come from another realm (vm sandbox).
        if (a && typeof a === 'object' && typeof a.message === 'string' && a.stack) return a.message;
        if (typeof a === 'object') {
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }
        return String(a);
    }).join(' ');
    const line = new Date().toISOString().substr(11, 12) + ' ' + level + ' ' + text;
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    try { console.log('[PhoneBrowser] ' + line); } catch (e) { /* no console */ }
}

module.exports = {
    info: function () { write('INFO', arguments); },
    warn: function () { write('WARN', arguments); },
    error: function () { write('ERROR', arguments); },
    lines: () => lines.slice()
};
