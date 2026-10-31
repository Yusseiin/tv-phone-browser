'use strict';

// Phone Browser service. TizenBrew runs this on the TV (Node.js, inside a vm
// sandbox). It serves the phone remote on the LAN and drives the TizenBrew
// window, either over DevTools ("direct" mode) or through the agent script
// injected into every page ("compatibility" mode).

const http = require('http');
const crypto = require('crypto');
const urlLib = require('url');
const qrcode = require('qrcode-generator');
const ws = require('./ws');
const log = require('./log');
const Store = require('./store');
const net = require('./net');
const Cdp = require('./cdp').Cdp;

/* global TVR_CONFIG, __VERSION__, __PORT__, __AGENT_SOURCE__, __REMOTE_HTML__, __ICON_SVG__ */
const CONFIG = typeof TVR_CONFIG !== 'undefined' ? TVR_CONFIG : {};
const VERSION = __VERSION__;
const PORT = CONFIG.port || __PORT__;
const AGENT_SOURCE = __AGENT_SOURCE__;
const REMOTE_HTML = __REMOTE_HTML__;
const ICON_SVG = __ICON_SVG__;
const HOME_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Phone Browser</title></head>' +
    '<body style="background:#0b0d12"><script src="/agent.js"></script></body></html>';

const HOME_URL = 'http://127.0.0.1:' + PORT + '/home';
const ALLOWED_URL = /^(https?:\/\/|about:blank)/i;
const MAX_TABS = 30;
const KEYS = {
    'Enter': [13, 'Enter', '\r'],
    'Backspace': [8, 'Backspace'],
    'Tab': [9, 'Tab'],
    'Escape': [27, 'Escape'],
    ' ': [32, 'Space', ' '],
    'ArrowLeft': [37, 'ArrowLeft'],
    'ArrowUp': [38, 'ArrowUp'],
    'ArrowRight': [39, 'ArrowRight'],
    'ArrowDown': [40, 'ArrowDown'],
    'PageUp': [33, 'PageUp'],
    'PageDown': [34, 'PageDown'],
    'End': [35, 'End'],
    'Home': [36, 'Home'],
    'Delete': [46, 'Delete']
};

const store = new Store(CONFIG.dataFile || '/home/owner/share/tvPhoneBrowser.json');
const cdp = new Cdp({ ownPort: PORT, endpoints: CONFIG.cdpEndpoints, pickTarget: CONFIG.pickTarget });
const startedAt = Date.now();

const page = { url: '', title: '', vw: 1920, vh: 1080, zoom: 1, home: false, focus: null, dialog: null };
const cursor = { x: 960, y: 540, dragging: false };
const phones = [];
let agent = null;
let pairing = null;

function noop() {}

function mode() {
    if (cdp.attached) return 'cdp';
    return agent ? 'agent' : 'none';
}

// DevTools commands hang while a JS dialog is open, so only drive the page
// over DevTools when no dialog is showing.
function canDrive() {
    return cdp.attached && !page.dialog;
}

function phoneUrl() {
    return 'http://' + net.localIp() + ':' + PORT;
}

let qrCache = { url: null, svg: '' };
function qrSvg(text) {
    if (qrCache.url !== text) {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        qrCache = { url: text, svg: qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true }) };
    }
    return qrCache.svg;
}

// U+2028/U+2029 are valid in JSON but not in pre-ES2019 JS string literals.
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

function jsLiteral(value) {
    return JSON.stringify(value).replace(LINE_SEP, '\\u2028').replace(PARA_SEP, '\\u2029');
}

function recvExpression(msg) {
    return 'window.__tvr?window.__tvr.recv(' + jsLiteral(msg) + '):false';
}

// ---------------------------------------------------------------------------
// Messages to the page agent

function toAgent(msg, userGesture) {
    // requestFullscreen()/play() need a user gesture, which only DevTools can fake.
    if (agent && !(userGesture && canDrive())) {
        agent.send(JSON.stringify(msg));
        return Promise.resolve(true);
    }
    if (canDrive()) {
        return cdp.evaluate(recvExpression(msg), userGesture).catch((e) => {
            log.warn('Agent call failed:', e.message);
            return false;
        });
    }
    return Promise.resolve(false);
}

function pushHome() {
    if (!page.home) return;
    const url = phoneUrl();
    toAgent({ t: 'home', url: url, qr: qrSvg(url), bookmarks: store.bookmarks(), phones: phones.length, version: VERSION });
}

function ensureAgent() {
    if (!canDrive() || ensureAgent.busy) return;
    ensureAgent.busy = true;
    cdp.evaluate(AGENT_SOURCE + '\n;!!window.__tvr')
        .catch((e) => log.warn('Agent injection failed:', e.message))
        .then(() => {
            ensureAgent.busy = false;
            dropStaleAgent();
        });
}

// A socket can outlive its page (e.g. back/forward cache). If the page on
// screen has a different agent, stop routing messages to the old one.
function dropStaleAgent() {
    const conn = agent;
    if (!conn || !conn.pageId || !canDrive()) return;
    cdp.evaluate('window.__tvr?window.__tvr.pageId:null').then((id) => {
        if (agent !== conn || id === conn.pageId) return;
        log.info('Dropping the agent socket of a previous page');
        agent = null;
        conn.close(4000, 'Stale page');
        broadcast();
    }).catch(noop);
}

function readLayout() {
    if (!canDrive()) return;
    cdp.send('Page.getLayoutMetrics').then((m) => {
        const lv = m.layoutViewport;
        if (lv && lv.clientWidth && !agent) {
            page.vw = lv.clientWidth;
            page.vh = lv.clientHeight;
        }
    }).catch(noop);
}

function handleAgentEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.t) {
        case 'hello':
        case 'page':
            page.url = String(ev.url || '');
            page.title = String(ev.title || '');
            page.vw = ev.vw || page.vw;
            page.vh = ev.vh || page.vh;
            page.zoom = ev.zoom || 1;
            page.home = !!ev.home;
            cursor.x = Math.min(cursor.x, page.vw - 1);
            cursor.y = Math.min(cursor.y, page.vh - 1);
            updateActiveTab(page.url, page.title, ev.t === 'hello');
            if (ev.t === 'hello') {
                page.focus = ev.focus || null;
                pushHome();
                cursorChanged();
                if (pairing && pairing.expires > Date.now()) showPin();
            }
            broadcast();
            break;
        case 'focus':
            page.focus = ev.focus || null;
            broadcast();
            break;
        case 'blur':
            page.focus = null;
            broadcast();
            break;
        case 'value':
            if (page.focus) {
                page.focus.value = ev.value;
                broadcast();
            }
            break;
        case 'notice':
            toastPhones(String(ev.text || ''));
            break;
        case 'open': // the user clicked a link meant for a new tab
            if (/^https?:\/\//i.test(ev.url)) openTab(String(ev.url), false);
            break;
        case 'popup': // the page opened a window on its own
            handlePopup(String(ev.url || ''));
            break;
        case 'remoteBack': // Back key on the TV remote
            goBack();
            break;
        case 'log':
            log.info('[page]', ev.text);
            break;
        default:
            break;
    }
}

function onAgentConnection(conn) {
    if (agent && agent !== conn) agent.close(4000, 'Replaced');
    agent = conn;
    conn.on('message', (text) => {
        let ev;
        try { ev = JSON.parse(text); } catch (e) { return; }
        if (ev && ev.t === 'hello') conn.pageId = ev.pageId;
        handleAgentEvent(ev);
    });
    conn.on('close', () => {
        if (agent === conn) {
            agent = null;
            broadcast();
        }
    });
}

// Without an agent WebSocket (e.g. blocked by a site's CSP), fetch the agent's
// queued events over DevTools instead.
let polling = false;
setInterval(() => {
    if (!canDrive() || agent || polling) return;
    polling = true;
    cdp.evaluate('window.__tvr?window.__tvr.drain():null')
        .then((events) => { if (Array.isArray(events)) events.forEach(handleAgentEvent); })
        .catch(noop)
        .then(() => { polling = false; });
}, 300);

// ---------------------------------------------------------------------------
// Pointer, scroll and keyboard

let cursorDirty = false;
let cursorBusy = false;

function cursorChanged() {
    cursorDirty = true;
    flushCursor();
}

function flushCursor() {
    if (cursorBusy || !cursorDirty) return;
    cursorDirty = false;
    const x = Math.round(cursor.x);
    const y = Math.round(cursor.y);
    const waits = [];
    const overlay = { t: 'cursor', x: x, y: y, hover: !cdp.attached };
    if (agent) agent.send(JSON.stringify(overlay));
    else if (canDrive()) waits.push(cdp.evaluate(recvExpression(overlay)).catch(noop));
    if (canDrive()) {
        waits.push(cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: x, y: y, button: cursor.dragging ? 'left' : 'none'
        }).catch(noop));
    }
    if (!waits.length) return;
    cursorBusy = true;
    Promise.all(waits).then(() => {
        cursorBusy = false;
        flushCursor();
    });
}

function moveCursor(x, y) {
    cursor.x = Math.max(0, Math.min(page.vw - 1, x));
    cursor.y = Math.max(0, Math.min(page.vh - 1, y));
    cursorChanged();
}

function mouseEvent(type, clickCount) {
    return cdp.send('Input.dispatchMouseEvent', {
        type: type,
        x: Math.round(cursor.x),
        y: Math.round(cursor.y),
        button: 'left',
        clickCount: clickCount || 1
    });
}

function click(count) {
    const x = Math.round(cursor.x);
    const y = Math.round(cursor.y);
    if (canDrive()) {
        toAgent({ t: 'ripple', x: x, y: y });
        return mouseEvent('mousePressed', count)
            .then(() => mouseEvent('mouseReleased', count))
            .catch((e) => log.warn('Click failed:', e.message));
    }
    return toAgent({ t: 'click', x: x, y: y, count: count || 1 });
}

function mouseButton(down) {
    cursor.dragging = down;
    if (canDrive()) return mouseEvent(down ? 'mousePressed' : 'mouseReleased', 1).catch(noop);
    return toAgent({ t: down ? 'down' : 'up', x: Math.round(cursor.x), y: Math.round(cursor.y) });
}

const scrollAcc = { dx: 0, dy: 0 };
let scrollBusy = false;
let wheelUnsupported = false;

function scroll(dx, dy) {
    scrollAcc.dx += dx;
    scrollAcc.dy += dy;
    flushScroll();
}

function flushScroll() {
    if (scrollBusy) return;
    const dx = Math.round(scrollAcc.dx);
    const dy = Math.round(scrollAcc.dy);
    if (!dx && !dy) return;
    scrollAcc.dx -= dx;
    scrollAcc.dy -= dy;
    const x = Math.round(cursor.x);
    const y = Math.round(cursor.y);
    const viaAgent = () => toAgent({ t: 'scroll', x: x, y: y, dx: dx, dy: dy });
    let p;
    if (canDrive() && !wheelUnsupported) {
        p = cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x, y: y, deltaX: dx, deltaY: dy })
            .catch((e) => {
                if (/invalid|enum|type/i.test(e.message)) {
                    wheelUnsupported = true;
                    log.warn('mouseWheel not supported, scrolling through the agent');
                }
                return viaAgent();
            });
    } else {
        p = viaAgent();
    }
    scrollBusy = true;
    p.then(() => {
        scrollBusy = false;
        flushScroll();
    });
}

function key(name) {
    const def = KEYS[name];
    if (!def) return Promise.resolve();
    if (!canDrive()) return toAgent({ t: 'key', key: name });
    const common = { key: name, code: def[1], windowsVirtualKeyCode: def[0], nativeVirtualKeyCode: def[0] };
    const down = { type: def[2] ? 'keyDown' : 'rawKeyDown' };
    if (def[2]) {
        down.text = def[2];
        down.unmodifiedText = def[2];
    }
    Object.keys(common).forEach((k) => { down[k] = common[k]; });
    const up = { type: 'keyUp' };
    Object.keys(common).forEach((k) => { up[k] = common[k]; });
    return cdp.send('Input.dispatchKeyEvent', down)
        .then(() => cdp.send('Input.dispatchKeyEvent', up))
        .catch((e) => log.warn('Key failed:', e.message));
}

// ---------------------------------------------------------------------------
// Navigation

function navigate(url) {
    if (!ALLOWED_URL.test(url)) return toastPhones('Only http and https addresses can be opened');
    if (page.dialog) return toastPhones('Answer the dialog on the TV first');
    page.focus = null;
    if (cdp.attached) {
        return cdp.send('Page.navigate', { url: url }).catch(() => toAgent({ t: 'nav', url: url }));
    }
    return toAgent({ t: 'nav', url: url });
}

function goHome() {
    return navigate(HOME_URL);
}

// All tabs share the TV's one window history. Back stays inside the active
// tab's own entries (from tab.base on); at the first page of a tab that was
// opened from another one, Back closes it and returns there, like Chrome on
// Android. Compatibility mode can't see the history and just goes back.
function goBack() {
    if (page.dialog) return toastPhones('Answer the dialog on the TV first');
    if (!canDrive()) return toAgent({ t: 'history', delta: -1 });
    const tab = activeTab;
    return cdp.send('Page.getNavigationHistory').then((h) => {
        const base = tab.base != null ? tab.base : 0;
        const prev = h.entries[h.currentIndex - 1];
        // ALLOWED_URL also keeps Back from leaving into TizenBrew's own UI.
        if (h.currentIndex - 1 >= base && prev && ALLOWED_URL.test(prev.url)) {
            return cdp.send('Page.navigateToHistoryEntry', { entryId: prev.id });
        }
        if (tab.openerId && findTab(tab.openerId)) return closeTab(tab.id);
        return toastPhones('Nothing to go back to');
    }).catch(() => toAgent({ t: 'history', delta: -1 }));
}

function goForward() {
    if (page.dialog) return toastPhones('Answer the dialog on the TV first');
    if (!canDrive()) return toAgent({ t: 'history', delta: 1 });
    return cdp.send('Page.getNavigationHistory').then((h) => {
        const next = h.entries[h.currentIndex + 1];
        if (!next || !ALLOWED_URL.test(next.url)) return toastPhones('Nothing to go forward to');
        return cdp.send('Page.navigateToHistoryEntry', { entryId: next.id });
    }).catch(() => toAgent({ t: 'history', delta: 1 }));
}

function reload() {
    if (page.dialog) return toastPhones('Answer the dialog on the TV first');
    if (canDrive()) return cdp.send('Page.reload', {}).catch(() => toAgent({ t: 'reload' }));
    return toAgent({ t: 'reload' });
}

// ---------------------------------------------------------------------------
// Tabs. The TV has one window: the active tab is what it shows, the others
// are remembered addresses that load again when you switch to them.

let tabSeq = 0;
const tabs = [];
let activeTab = null;
let switching = null; // set while the window loads another tab's page
let popupTimes = [];

function isHomeUrl(url) {
    return !url || url.indexOf('about:blank') === 0 || url.indexOf(HOME_URL) === 0;
}

function hostOf(url) {
    const m = /^https?:\/\/([^/?#]+)/i.exec(url || '');
    return m ? m[1].replace(/^www\./i, '') : 'Home';
}

function makeTab(url, title, openerId) {
    return {
        id: ++tabSeq,
        url: url,
        title: title || (isHomeUrl(url) ? 'Home' : hostOf(url)),
        openerId: openerId || null,
        base: null, // window history index of the tab's first page
        created: Date.now()
    };
}

function findTab(id) {
    return tabs.filter((t) => t.id === id)[0] || null;
}

function saveTabs() {
    store.setTabs(tabs.filter((t) => !isHomeUrl(t.url)).map((t) => ({ url: t.url, title: t.title })));
}

// Tabs from the last session come back as background tabs.
store.tabs().forEach((t) => {
    if (t && /^https?:\/\//i.test(t.url)) tabs.push(makeTab(t.url, t.title));
});
activeTab = makeTab(HOME_URL, 'Home');
tabs.push(activeTab);

// Keep the active tab's address and title in step with the page. While a
// tab switch is loading, late reports from the previous page are ignored;
// `fresh` marks reports that come from the newly loaded page.
function updateActiveTab(url, title, fresh) {
    if (switching) {
        if (!fresh && Date.now() - switching.since < 10000) return;
        switching = null;
    }
    // Error pages and the like keep the tab's real address.
    if (!ALLOWED_URL.test(url || '')) return;
    const before = activeTab.url + '|' + activeTab.title;
    activeTab.url = url;
    if (isHomeUrl(url)) activeTab.title = 'Home';
    else if (title) activeTab.title = title;
    else if (fresh) activeTab.title = hostOf(url);
    if (before !== activeTab.url + '|' + activeTab.title) saveTabs();
}

function activateTab(tab) {
    if (!tab || tab === activeTab) return;
    if (page.dialog) return toastPhones('Answer the dialog on the TV first');
    activeTab = tab;
    tab.base = null;
    switching = { tab: tab, since: Date.now() };
    page.focus = null;
    navigate(isHomeUrl(tab.url) ? HOME_URL : tab.url);
    broadcast();
}

function trimTabs() {
    while (tabs.length > MAX_TABS) {
        const oldest = tabs.filter((t) => t !== activeTab).sort((a, b) => a.created - b.created)[0];
        tabs.splice(tabs.indexOf(oldest), 1);
    }
}

function openTab(url, background) {
    const tab = makeTab(url, null, activeTab.id);
    tabs.splice(tabs.indexOf(activeTab) + 1, 0, tab);
    trimTabs();
    if (!background) activateTab(tab);
    saveTabs();
    broadcast();
    return tab;
}

function closeTab(id) {
    const tab = findTab(id);
    if (!tab) return;
    const index = tabs.indexOf(tab);
    tabs.splice(index, 1);
    if (!tabs.length) {
        const home = makeTab(HOME_URL, 'Home');
        tabs.push(home);
        activateTab(home);
    } else if (tab === activeTab) {
        activateTab(findTab(tab.openerId) || tabs[Math.min(index, tabs.length - 1)]);
    }
    saveTabs();
    broadcast();
}

function closeOtherTabs() {
    tabs.splice(0, tabs.length, activeTab);
    saveTabs();
    broadcast();
}

// A page opened a window by itself (ads, mostly). It never takes over the
// screen: it becomes a background tab, or is dropped if pop-ups are blocked.
function handlePopup(url) {
    if (!/^https?:\/\//i.test(url)) return;
    const now = Date.now();
    // Pop-under scripts tend to fire on every click; don't pile up copies.
    if (tabs.some((t) => t.url === url && now - t.created < 60000)) return;
    popupTimes = popupTimes.filter((at) => now - at < 10000);
    const notice = { t: 'popup', url: url, host: hostOf(url), blocked: true };
    if (store.setting('blockPopups') || popupTimes.length >= 5) {
        log.info('Blocked a pop-up:', url);
        return sendAll(notice);
    }
    popupTimes.push(now);
    const tab = openTab(url, true);
    notice.blocked = false;
    notice.tabId = tab.id;
    log.info('Pop-up moved to a background tab:', url);
    toAgent({ t: 'toast', text: 'Pop-up moved to a background tab' });
    sendAll(notice);
}

// ---------------------------------------------------------------------------
// Screen preview on the phone

let screenState = 'off'; // off | cast | poll
let latestFrame = null;
let frameSeq = 0;

function wantScreen() {
    return cdp.attached && phones.some((p) => p.screen);
}

function updateScreen() {
    if (wantScreen()) {
        if (screenState !== 'off') return;
        screenState = 'cast';
        cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 960, maxHeight: 540, everyNthFrame: 1 })
            .catch((e) => {
                log.warn('Screencast unavailable, using screenshots:', e.message);
                screenState = 'poll';
                pollScreen();
            });
    } else if (screenState !== 'off') {
        if (screenState === 'cast' && cdp.attached) cdp.send('Page.stopScreencast').catch(noop);
        screenState = 'off';
    }
}

function pollScreen() {
    if (screenState !== 'poll') return;
    if (!wantScreen()) return updateScreen();
    if (page.dialog) return setTimeout(pollScreen, 500);
    cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 40 }, 10000).then((r) => {
        deliverFrame(r.data, page.vw, page.vh);
        setTimeout(pollScreen, 300);
    }).catch((e) => {
        log.warn('Screenshots unavailable:', e.message);
        screenState = 'off';
        phones.forEach((p) => {
            if (!p.screen) return;
            p.screen = false;
            sendTo(p, { t: 'screen', supported: false });
        });
    });
}

cdp.on('Page.screencastFrame', (p) => {
    const meta = p.metadata || {};
    deliverFrame(p.data, meta.deviceWidth || page.vw, meta.deviceHeight || page.vh);
    // Acking lets Chromium produce the next frame; the delay caps the frame rate.
    setTimeout(() => {
        if (cdp.attached) cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(noop);
    }, 120);
});

function deliverFrame(data, w, h) {
    latestFrame = { data: data, w: w, h: h, seq: ++frameSeq };
    phones.forEach((p) => {
        if (p.screen && !p.awaitingFrame) sendFrame(p);
    });
}

function sendFrame(p) {
    if (!latestFrame || p.lastFrameSeq === latestFrame.seq) return;
    p.awaitingFrame = true;
    p.lastFrameSeq = latestFrame.seq;
    sendTo(p, { t: 'frame', data: latestFrame.data, w: latestFrame.w, h: latestFrame.h });
}

// ---------------------------------------------------------------------------
// DevTools events

cdp.on('attached', () => {
    // Lets us catch windows that slip past the agent (see onTargetInfo).
    cdp.send('Target.setDiscoverTargets', { discover: true })
        .catch((e) => log.info('Pop-up window detection unavailable:', e.message));
    ensureAgent();
    readLayout();
    updateScreen();
    broadcast();
});

cdp.on('detached', () => {
    screenState = 'off';
    page.dialog = null;
    broadcast();
});

cdp.on('Page.frameNavigated', (p) => {
    if (!p.frame || p.frame.parentId) return;
    const loadingTab = switching && switching.tab;
    page.url = p.frame.url;
    page.focus = null;
    updateActiveTab(p.frame.url, null, true);
    // Remember where this tab's history starts, so Back stays inside it.
    if (loadingTab && loadingTab === activeTab) {
        cdp.send('Page.getNavigationHistory').then((h) => { loadingTab.base = h.currentIndex; }).catch(noop);
    }
    broadcast();
});

// Windows the agent couldn't intercept (pop-ups from ad frames it doesn't run
// in, forms submitted by script...) appear as new DevTools targets opened by
// our page. Close them right away and keep their address as a background tab.
let lastWindowOpen = null;
const closedWindows = {};

cdp.on('Page.windowOpen', (p) => {
    lastWindowOpen = { url: p.url, at: Date.now() };
});

function onTargetInfo(info) {
    if (!info || info.type !== 'page' || !cdp.targetId) return;
    if (info.targetId === cdp.targetId || info.openerId !== cdp.targetId || closedWindows[info.targetId]) return;
    closedWindows[info.targetId] = true;
    let url = info.url;
    if ((!url || url === 'about:blank') && lastWindowOpen && Date.now() - lastWindowOpen.at < 3000) url = lastWindowOpen.url;
    cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(noop);
    log.info('Closed a pop-up window:', url || '(no address)');
    if (url) handlePopup(url);
}

cdp.on('Target.targetCreated', (p) => onTargetInfo(p.targetInfo));

cdp.on('Page.domContentEventFired', () => ensureAgent());
cdp.on('Page.loadEventFired', () => {
    ensureAgent();
    readLayout();
});

cdp.on('Page.javascriptDialogOpening', (p) => {
    page.dialog = { type: p.type, message: p.message || '', defaultPrompt: p.defaultPrompt || '' };
    broadcast();
});

cdp.on('Page.javascriptDialogClosed', () => {
    page.dialog = null;
    broadcast();
});

// ---------------------------------------------------------------------------
// Phones

function sendTo(phone, msg) {
    phone.conn.send(JSON.stringify(msg));
}

function sendAll(msg) {
    const text = JSON.stringify(msg);
    phones.forEach((p) => p.conn.send(text));
}

function toastPhones(text) {
    sendAll({ t: 'toast', text: text });
}

function stateMessage() {
    return {
        t: 'state',
        mode: mode(),
        url: page.url,
        title: page.title,
        home: page.home,
        zoom: page.zoom,
        focus: page.focus,
        dialog: page.dialog,
        vw: page.vw,
        vh: page.vh,
        bookmarks: store.bookmarks(),
        tabs: tabs.map((t) => ({ id: t.id, url: isHomeUrl(t.url) ? '' : t.url, title: t.title })),
        activeTab: activeTab.id,
        blockPopups: !!store.setting('blockPopups'),
        version: VERSION
    };
}

let broadcastTimer = null;
function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        const text = JSON.stringify(stateMessage());
        phones.forEach((p) => p.conn.send(text));
    }, 50);
}

function handlePhone(phone, msg) {
    switch (msg.t) {
        case 'ping':
            sendTo(phone, { t: 'pong' });
            break;
        case 'move':
            moveCursor(cursor.x + (Number(msg.dx) || 0), cursor.y + (Number(msg.dy) || 0));
            break;
        case 'moveTo':
            moveCursor((Number(msg.fx) || 0) * page.vw, (Number(msg.fy) || 0) * page.vh);
            break;
        case 'click':
            click(msg.count === 2 ? 2 : 1);
            break;
        case 'down':
            mouseButton(true);
            break;
        case 'up':
            mouseButton(false);
            break;
        case 'scroll':
            scroll(Number(msg.dx) || 0, Number(msg.dy) || 0);
            break;
        case 'key':
            key(String(msg.key));
            break;
        case 'text':
            toAgent({ t: 'text', value: String(msg.value == null ? '' : msg.value) });
            break;
        case 'select':
            toAgent({ t: 'select', index: Number(msg.index) || 0 });
            break;
        case 'nav':
            navigate(String(msg.url || ''));
            break;
        case 'back':
            goBack();
            break;
        case 'forward':
            goForward();
            break;
        case 'tabNew':
            openTab(HOME_URL, false);
            break;
        case 'tabOpen':
            if (/^https?:\/\//i.test(msg.url)) openTab(String(msg.url), false);
            break;
        case 'tabSwitch':
            activateTab(findTab(Number(msg.id)));
            break;
        case 'tabClose':
            closeTab(Number(msg.id));
            break;
        case 'tabCloseOthers':
            closeOtherTabs();
            break;
        case 'setting':
            if (msg.key === 'blockPopups') {
                store.setSetting('blockPopups', !!msg.value);
                broadcast();
            }
            break;
        case 'reload':
            reload();
            break;
        case 'home':
            goHome();
            break;
        case 'zoom':
            toAgent({ t: 'zoom', dir: Number(msg.dir) || 0 });
            break;
        case 'media':
            toAgent({ t: 'media', action: String(msg.action), delta: Number(msg.delta) || 0 }, true);
            break;
        case 'dialog':
            if (!cdp.attached || !page.dialog) break;
            cdp.send('Page.handleJavaScriptDialog', { accept: !!msg.accept, promptText: String(msg.text || '') })
                .catch(noop)
                .then(() => {
                    page.dialog = null;
                    broadcast();
                });
            break;
        case 'screen':
            phone.screen = !!msg.on;
            phone.awaitingFrame = false;
            phone.lastFrameSeq = 0;
            if (phone.screen && !cdp.attached) {
                phone.screen = false;
                sendTo(phone, { t: 'screen', supported: false });
            }
            updateScreen();
            if (phone.screen) sendFrame(phone);
            break;
        case 'frameAck':
            phone.awaitingFrame = false;
            if (phone.screen) sendFrame(phone);
            break;
        case 'bookmarkAdd':
            store.addBookmark(msg.title || page.title, msg.url || page.url);
            broadcast();
            pushHome();
            break;
        case 'bookmarkRemove':
            store.removeBookmark(String(msg.url));
            broadcast();
            pushHome();
            break;
        case 'forget':
            store.removeToken(phone.token);
            phone.conn.close(4001, 'Unpaired');
            break;
        case 'forgetAll':
            store.clearTokens();
            phones.slice().forEach((p) => p.conn.close(4001, 'Unpaired'));
            break;
        default:
            break;
    }
}

function onPhoneConnection(conn, token) {
    if (!store.hasToken(token)) {
        conn.send(JSON.stringify({ t: 'auth', ok: false }));
        conn.close(4001, 'Not paired');
        return;
    }
    const phone = { conn: conn, token: token, screen: false, awaitingFrame: false, lastFrameSeq: 0 };
    phones.push(phone);
    log.info('Phone connected (' + phones.length + ' total)');
    sendTo(phone, stateMessage());
    pushHome();
    conn.on('message', (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (msg && typeof msg.t === 'string') handlePhone(phone, msg);
    });
    conn.on('close', () => {
        const i = phones.indexOf(phone);
        if (i !== -1) phones.splice(i, 1);
        updateScreen();
        pushHome();
    });
}

// ---------------------------------------------------------------------------
// Pairing

function randomPin() {
    return ('0000' + (crypto.randomBytes(2).readUInt16BE(0) % 10000)).slice(-4);
}

function showPin() {
    const seconds = Math.max(0, Math.round((pairing.expires - Date.now()) / 1000));
    return toAgent({ t: 'pin', pin: pairing.pin, seconds: seconds });
}

function startPairing() {
    if (!pairing || pairing.expires < Date.now()) {
        pairing = { pin: CONFIG.testPin || randomPin(), expires: Date.now() + 120000, attempts: 0 };
    }
    showPin();
    return mode() !== 'none';
}

function finishPairing(pin, name) {
    if (!pairing || pairing.expires < Date.now()) return { status: 410, body: { error: 'expired' } };
    if (String(pin) !== pairing.pin) {
        pairing.attempts++;
        if (pairing.attempts >= 5) {
            pairing = null;
            toAgent({ t: 'pin', pin: null });
            return { status: 403, body: { error: 'locked' } };
        }
        return { status: 403, body: { error: 'wrong' } };
    }
    const token = crypto.randomBytes(24).toString('hex');
    store.addToken(token, String(name || 'Phone').substr(0, 60));
    pairing = null;
    toAgent({ t: 'pin', pin: null });
    toAgent({ t: 'toast', text: 'Phone paired' });
    log.info('Paired a new phone');
    return { status: 200, body: { token: token } };
}

// ---------------------------------------------------------------------------
// HTTP server

function respond(res, status, type, body, headers) {
    const h = { 'Content-Type': type, 'Cache-Control': 'no-store' };
    if (headers) Object.keys(headers).forEach((k) => { h[k] = headers[k]; });
    res.writeHead(status, h);
    res.end(body);
}

function respondJson(res, status, obj) {
    respond(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function readJsonBody(req, callback) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
        body += c;
        if (body.length > 10000) req.destroy();
    });
    req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (e) { /* empty */ }
        callback(parsed);
    });
}

function isLoopback(address) {
    return /^(::ffff:)?127\./.test(address || '') || address === '::1';
}

function status() {
    return {
        name: 'Phone Browser',
        version: VERSION,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        node: process.version,
        mode: mode(),
        devtools: { attached: cdp.attached, endpoint: cdp.endpoint, lastError: cdp.lastError, scans: cdp.scans },
        agentConnected: !!agent,
        phones: phones.length,
        screen: screenState,
        phoneUrl: phoneUrl()
    };
}

const server = http.createServer((req, res) => {
    const u = urlLib.parse(req.url, true);
    const path = u.pathname;

    if (req.method === 'GET') {
        switch (path) {
            case '/':
            case '/index.html':
                return respond(res, 200, 'text/html; charset=utf-8', REMOTE_HTML);
            case '/home':
                return respond(res, 200, 'text/html; charset=utf-8', HOME_HTML);
            case '/agent.js':
                return respond(res, 200, 'application/javascript; charset=utf-8', AGENT_SOURCE);
            case '/icon.svg':
                return respond(res, 200, 'image/svg+xml', ICON_SVG);
            case '/manifest.webmanifest':
                return respond(res, 200, 'application/manifest+json', JSON.stringify({
                    name: 'Phone Browser',
                    short_name: 'TV Browser',
                    start_url: '/',
                    display: 'standalone',
                    background_color: '#0f1115',
                    theme_color: '#0f1115',
                    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]
                }));
            case '/api/status':
                return respondJson(res, 200, status());
            case '/api/logs':
                if (!store.hasToken(u.query.token)) return respondJson(res, 401, { error: 'not paired' });
                return respondJson(res, 200, { lines: log.lines() });
            default:
                break;
        }
    } else if (req.method === 'POST') {
        if (path === '/api/pair/start') {
            return respondJson(res, 200, { ok: true, shown: startPairing() });
        }
        if (path === '/api/pair') {
            return readJsonBody(req, (body) => {
                const result = finishPairing(body.pin, body.name);
                respondJson(res, result.status, result.body);
            });
        }
    }
    respond(res, 404, 'text/plain', 'Not found');
});

server.on('upgrade', (req, socket, head) => {
    const u = urlLib.parse(req.url, true);
    if (u.pathname === '/agent') {
        // Only pages running on the TV itself may act as the agent.
        if (!isLoopback(socket.remoteAddress)) return socket.destroy();
        const conn = ws.acceptUpgrade(req, socket, head);
        if (conn) onAgentConnection(conn);
    } else if (u.pathname === '/ws') {
        const conn = ws.acceptUpgrade(req, socket, head);
        if (conn) onPhoneConnection(conn, u.query.token);
    } else {
        socket.destroy();
    }
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log.warn('Port ' + PORT + ' already in use: the service is probably already running');
    else log.error('Server error:', e.message);
});

server.on('listening', () => {
    log.info('Phone Browser ' + VERSION + ' listening on ' + phoneUrl());
    cdp.start();
});

server.listen(PORT, '0.0.0.0');
