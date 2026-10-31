'use strict';

// The TV's LAN address, shown on the TV home screen and encoded in the QR code.

const os = require('os');

let tizenIp = null;

function lookupTizenIp() {
    if (typeof tizen === 'undefined' || !tizen.systeminfo) return;
    ['WIFI_NETWORK', 'ETHERNET_NETWORK'].forEach((prop) => {
        try {
            tizen.systeminfo.getPropertyValue(prop, (info) => {
                if (info && info.ipAddress && info.ipAddress !== '0.0.0.0') tizenIp = info.ipAddress;
            }, () => {});
        } catch (e) { /* property not supported */ }
    });
}

function interfaceIp() {
    let best = null;
    try {
        const ifaces = os.networkInterfaces();
        Object.keys(ifaces).forEach((name) => {
            ifaces[name].forEach((addr) => {
                if (addr.family !== 'IPv4' && addr.family !== 4) return;
                if (addr.internal || /^169\.254\./.test(addr.address)) return;
                // Prefer wired/wireless interfaces over virtual ones.
                const score = /^(eth|wlan|en|wl)/.test(name) ? 2 : 1;
                if (!best || score > best.score) best = { address: addr.address, score: score };
            });
        });
    } catch (e) { /* not available */ }
    return best ? best.address : null;
}

function localIp() {
    lookupTizenIp();
    return interfaceIp() || tizenIp || '127.0.0.1';
}

module.exports = { localIp };
