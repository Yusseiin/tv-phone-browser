// Phone Browser page agent. TizenBrew injects this into every page the TV
// opens (and the service re-injects it over DevTools). It draws the cursor,
// renders the TV home screen, reports focus/page changes to the service and,
// when DevTools is unavailable, performs input with synthetic DOM events.

/* global __PORT__, __VERSION__ */
(function () {
    'use strict';

    if (window.top !== window) {
        guardFrame();
        return;
    }
    if (window.__tvr) return;
    // Never take over TizenBrew's own launcher UI.
    if (/\/tizenbrew-ui\//.test(location.pathname)) return;

    var PORT = __PORT__;
    var VERSION = __VERSION__;
    var ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    var TEXT_INPUT = /^(text|search|email|url|tel|password|number|)$/i;
    var KEYCODES = {
        Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34,
        End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46
    };
    var TV_KEYS = { back: 10009, playPause: 10252, play: 415, pause: 19, stop: 413, rewind: 412, forward: 417 };

    var pageId = Math.random().toString(36).slice(2);
    var queue = [];
    var lastDrain = 0;
    var syntheticClicks = 0; // > 0 while doClick() dispatches its events
    var socket = null;
    var socketOpen = false;
    var everConnected = false;
    var failures = 0;
    var cursor = { x: -100, y: -100 };
    var hoverEl = null;
    var hideTimer = null;
    var ui = null;
    var homeInfo = null;
    var lastPage = '';
    var theater = null;

    var api = { version: VERSION, pageId: pageId, recv: recv, drain: drain };
    try {
        Object.defineProperty(window, '__tvr', { value: api, configurable: true });
    } catch (e) {
        window.__tvr = api;
    }

    function isHome() {
        if (location.href.indexOf('about:blank') === 0) return true;
        return location.pathname === '/home' && String(location.port) === String(PORT) &&
            (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
    }

    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    // ------------------------------------------------------------------
    // Channel to the service

    function emit(msg) {
        if (socketOpen) {
            socket.send(JSON.stringify(msg));
        } else {
            queue.push(msg);
            if (queue.length > 100) queue.shift();
        }
    }

    function drain() {
        lastDrain = Date.now();
        var q = queue;
        queue = [];
        return q;
    }

    function pageInfo(type) {
        return {
            t: type,
            pageId: pageId,
            url: location.href,
            title: isHome() ? 'Home' : document.title,
            vw: window.innerWidth,
            vh: window.innerHeight,
            zoom: getZoom(),
            home: isHome(),
            version: VERSION
        };
    }

    function connect() {
        try {
            socket = new WebSocket('ws://127.0.0.1:' + PORT + '/agent');
        } catch (e) {
            socket = null;
            return retry();
        }
        socket.onopen = function () {
            socketOpen = true;
            everConnected = true;
            failures = 0;
            var hello = pageInfo('hello');
            hello.focus = describeFocus(document.activeElement);
            socket.send(JSON.stringify(hello));
            drain().forEach(function (m) { socket.send(JSON.stringify(m)); });
        };
        socket.onmessage = function (e) {
            var msg;
            try { msg = JSON.parse(e.data); } catch (err) { return; }
            recv(msg);
        };
        socket.onclose = function () {
            socketOpen = false;
            socket = null;
            retry();
        };
    }

    // Pages kept in the back/forward cache must not keep talking to the
    // service as if they were still on screen.
    window.addEventListener('pagehide', function () {
        if (!socket) return;
        var s = socket;
        socket = null;
        socketOpen = false;
        s.onclose = null;
        try { s.close(); } catch (e) { /* already closed */ }
    });
    window.addEventListener('pageshow', function (e) {
        if (e.persisted && !socket) {
            failures = 0;
            connect();
        }
    });

    function retry() {
        failures++;
        // A site's CSP may block the connection for good; then the service
        // falls back to polling drain() over DevTools. Keep trying on the home
        // screen, where the service may simply still be starting.
        if (!everConnected && failures > 3 && !isHome()) return;
        setTimeout(connect, Math.min(10000, 500 * failures));
    }

    // ------------------------------------------------------------------
    // Commands from the service

    function recv(msg) {
        if (!msg || typeof msg !== 'object') return false;
        switch (msg.t) {
            case 'cursor': setCursor(msg.x, msg.y, msg.hover); return true;
            case 'ripple': ripple(msg.x, msg.y); return true;
            case 'click': doClick(msg.x, msg.y, msg.count || 1); return true;
            case 'down': mouseButton(msg.x, msg.y, true); return true;
            case 'up': mouseButton(msg.x, msg.y, false); return true;
            case 'scroll': doScroll(msg.x, msg.y, msg.dx, msg.dy); return true;
            case 'key': doKey(msg.key); return true;
            case 'text': return setText(msg.value);
            case 'select': return setSelect(msg.index);
            case 'nav': location.href = msg.url; return true;
            case 'history': goHistory(msg.delta); return true;
            case 'reload': location.reload(); return true;
            case 'zoom': changeZoom(msg.dir); return true;
            case 'media': return media(msg.action, msg.delta);
            case 'home': homeInfo = msg; renderHome(); return true;
            case 'pin': showPin(msg.pin, msg.seconds); return true;
            case 'toast': toast(msg.text); return true;
            default: return false;
        }
    }

    // ------------------------------------------------------------------
    // New tabs and pop-ups. The TV has a single window, so the agent stops
    // every attempt to open another one and reports it to the service, which
    // keeps it as a tab: 'open' for links the user clicked, 'popup' for
    // windows the page opened by itself.

    function absoluteUrl(url) {
        // baseURI, not location: about:srcdoc frames resolve against their parent.
        try { return String(new URL(String(url), document.baseURI || location.href)); } catch (e) { return null; }
    }

    function opensNewWindow(target) {
        return !!target && !/^_(self|parent|top)$/i.test(target);
    }

    function attached(el) {
        return el.isConnected !== undefined ? el.isConnected : document.documentElement.contains(el);
    }

    // Stand-in for the window a page asked window.open() for. Pages often
    // open a blank window first and set its location afterwards.
    function fakeWindow(onUrl) {
        function noop() {}
        var loc = {
            assign: function (u) { onUrl(u); },
            replace: function (u) { onUrl(u); },
            reload: noop,
            toString: function () { return 'about:blank'; }
        };
        Object.defineProperty(loc, 'href', { get: function () { return 'about:blank'; }, set: function (u) { onUrl(u); } });
        var w = {
            closed: false,
            opener: window,
            name: '',
            document: { write: noop, writeln: noop, open: noop, close: noop },
            focus: noop,
            blur: noop,
            postMessage: noop,
            moveTo: noop,
            resizeTo: noop,
            close: function () { w.closed = true; }
        };
        Object.defineProperty(w, 'location', { get: function () { return loc; }, set: function (u) { onUrl(u); } });
        return w;
    }

    function installPopupGuards(report) {
        function send(kind, url) {
            var abs = absoluteUrl(url);
            if (abs && /^https?:/i.test(abs)) report(kind, abs);
        }

        var nativeOpen = window.open;
        window.open = function (url, name) {
            if (/^_(self|parent|top)$/i.test(name || '')) return nativeOpen.apply(window, arguments);
            if (url) send('popup', url);
            return fakeWindow(function (u) { send('popup', u); });
        };

        // Links meant for a new tab: decided after the page's own handlers
        // ran, since they may cancel the click or handle it themselves.
        document.addEventListener('click', function (e) {
            var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a || a.hasAttribute('download') || !opensNewWindow(a.getAttribute('target'))) return;
            var original = a.getAttribute('target');
            // If the page stops the event before the check below, stay in this window.
            a.setAttribute('target', '_self');
            setTimeout(function () { a.setAttribute('target', original); }, 0);
            e.__tvrLink = { url: a.href, user: e.isTrusted || syntheticClicks > 0 };
        }, true);
        window.addEventListener('click', function (e) {
            var link = e.__tvrLink;
            if (!link || e.defaultPrevented) return;
            var abs = absoluteUrl(link.url);
            if (!abs || !/^https?:/i.test(abs)) return; // e.g. javascript: links keep their default
            e.preventDefault();
            report(link.user ? 'open' : 'popup', abs);
        });

        document.addEventListener('submit', function (e) {
            var form = e.target;
            if (form && form.getAttribute && opensNewWindow(form.getAttribute('target'))) form.setAttribute('target', '_self');
        }, true);

        // Pop-under scripts click links that were never added to the page,
        // which the listeners above can't see.
        var nativeClick = HTMLElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (!attached(this) && opensNewWindow(this.getAttribute('target'))) return send('popup', this.href);
            return nativeClick.call(this);
        };
        var nativeDispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (ev) {
            if (ev && ev.type === 'click' && this instanceof HTMLAnchorElement && !attached(this) &&
                opensNewWindow(this.getAttribute('target'))) {
                send('popup', this.href);
                return false;
            }
            return nativeDispatch.apply(this, arguments);
        };
    }

    // In frames (ads, embeds) the agent only guards against new windows and
    // hands them to the top page's agent.
    function guardFrame() {
        if (window.__tvrFrame) return;
        window.__tvrFrame = true;
        installPopupGuards(function (kind, url) {
            try { window.top.postMessage({ __tvr: kind, url: url }, '*'); } catch (e) { /* top is gone */ }
        });
    }

    // ------------------------------------------------------------------
    // Overlay: cursor, click ripple, toasts, pairing code

    var CURSOR_SVG = '<svg width="34" height="46" viewBox="0 0 17 23" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M1 1 L1 18 L5.2 14.2 L8.2 21 L11 19.8 L8.1 13.2 L14 13.2 Z" fill="#fff" stroke="#111" ' +
        'stroke-width="1.3" stroke-linejoin="round"/></svg>';

    var OVERLAY_CSS =
        '.tvr-cur{position:fixed;left:0;top:0;width:34px;height:46px;pointer-events:none;' +
        'filter:drop-shadow(0 2px 4px rgba(0,0,0,.55));transition:opacity .3s;opacity:0;will-change:transform}' +
        '.tvr-cur.on{opacity:1}' +
        '.tvr-ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;' +
        'border:3px solid #4f8cff;pointer-events:none;animation:tvr-r .45s ease-out forwards}' +
        '@keyframes tvr-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}' +
        '.tvr-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);max-width:70vw;' +
        'background:rgba(20,22,28,.92);color:#fff;font:500 26px/1.35 system-ui,-apple-system,sans-serif;' +
        'padding:16px 30px;border-radius:40px;box-shadow:0 8px 30px rgba(0,0,0,.5);opacity:0;transition:opacity .25s;pointer-events:none}' +
        '.tvr-toast.on{opacity:1}' +
        '.tvr-pin{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#14161c;color:#fff;' +
        'border-radius:28px;padding:44px 72px;text-align:center;font-family:system-ui,-apple-system,sans-serif;' +
        'box-shadow:0 20px 80px rgba(0,0,0,.7);border:2px solid #2b3140;display:none}' +
        '.tvr-pin.on{display:block}' +
        '.tvr-pin h2{margin:0 0 18px;font-size:30px;font-weight:500;color:#aab3c5}' +
        '.tvr-pin b{display:block;font-size:120px;letter-spacing:.18em;font-weight:700;line-height:1;margin-left:.18em}' +
        '.tvr-pin p{margin:22px 0 0;font-size:24px;color:#7d879c}';

    function ensureUi() {
        var root = document.documentElement;
        if (!root) return null;
        if (ui && ui.host.parentNode) return ui;
        var host = document.createElement('tvr-overlay');
        host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
        var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
        shadow.innerHTML = '<style>' + OVERLAY_CSS + '</style>' +
            '<div class="tvr-cur">' + CURSOR_SVG + '</div>' +
            '<div class="tvr-toast"></div>' +
            '<div class="tvr-pin"><h2>Pairing code</h2><b></b><p>Enter it on your phone</p></div>';
        ui = {
            host: host,
            root: shadow,
            cur: shadow.querySelector('.tvr-cur'),
            toast: shadow.querySelector('.tvr-toast'),
            pin: shadow.querySelector('.tvr-pin'),
            pinCode: shadow.querySelector('.tvr-pin b')
        };
        placeOverlay();
        return ui;
    }

    // Fullscreen elements live in the top layer; move the overlay inside them.
    function placeOverlay() {
        if (!ui) return;
        var fs = document.fullscreenElement || document.webkitFullscreenElement;
        var parent = fs && !/^(VIDEO|IMG|CANVAS|IFRAME)$/.test(fs.tagName) ? fs : document.documentElement;
        if (parent && ui.host.parentNode !== parent) parent.appendChild(ui.host);
    }
    document.addEventListener('fullscreenchange', placeOverlay);
    document.addEventListener('webkitfullscreenchange', placeOverlay);

    function setCursor(x, y, hover) {
        cursor.x = x;
        cursor.y = y;
        var u = ensureUi();
        if (!u) return;
        u.cur.style.transform = 'translate(' + x + 'px,' + y + 'px)';
        u.cur.className = 'tvr-cur on';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { u.cur.className = 'tvr-cur'; }, 6000);
        if (hover) syntheticHover(x, y);
    }

    function ripple(x, y) {
        var u = ensureUi();
        if (!u) return;
        var r = document.createElement('div');
        r.className = 'tvr-ripple';
        r.style.left = x + 'px';
        r.style.top = y + 'px';
        u.root.appendChild(r);
        setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 500);
    }

    var toastTimer = null;
    function toast(text) {
        var u = ensureUi();
        if (!u || !text) return;
        u.toast.textContent = text;
        u.toast.className = 'tvr-toast on';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { u.toast.className = 'tvr-toast'; }, 3000);
    }

    var pinTimer = null;
    function showPin(pin, seconds) {
        var u = ensureUi();
        if (!u) return;
        clearTimeout(pinTimer);
        if (!pin) {
            u.pin.className = 'tvr-pin';
            return;
        }
        u.pinCode.textContent = pin;
        u.pin.className = 'tvr-pin on';
        pinTimer = setTimeout(function () { u.pin.className = 'tvr-pin'; }, (seconds || 120) * 1000);
    }

    // ------------------------------------------------------------------
    // TV home screen

    var HOME_CSS =
        'html,body{margin:0;height:100%;background:#0b0d12;color:#e8ebf2;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}' +
        '.h-wrap{box-sizing:border-box;height:100%;padding:72px 96px;display:flex;flex-direction:column;' +
        'background:radial-gradient(1200px 600px at 85% -10%,rgba(79,140,255,.18),transparent),radial-gradient(900px 500px at -10% 110%,rgba(140,90,255,.12),transparent)}' +
        '.h-top{display:flex;gap:80px;align-items:center;flex:1}' +
        '.h-text{flex:1}' +
        '.h-brand{font-size:30px;color:#8fb3ff;font-weight:600;letter-spacing:.02em;margin-bottom:18px}' +
        '.h-title{font-size:64px;font-weight:700;line-height:1.1;margin:0 0 28px}' +
        '.h-steps{font-size:30px;line-height:1.7;color:#b7bfd0;margin:0;padding-left:1.2em}' +
        '.h-url{display:inline-block;margin-top:8px;font-size:38px;font-weight:600;color:#fff;background:#1a1f2b;border:2px solid #2c3446;padding:10px 26px;border-radius:16px}' +
        '.h-qr{width:330px;height:330px;background:#fff;border-radius:24px;padding:18px;box-sizing:border-box;flex:none}' +
        '.h-qr svg{width:100%;height:100%;display:block}' +
        '.h-status{font-size:24px;color:#7d879c;margin-top:26px}' +
        '.h-status i{display:inline-block;width:14px;height:14px;border-radius:50%;background:#59607a;margin-right:12px;vertical-align:middle}' +
        '.h-status.ok i{background:#3ecf8e}' +
        '.h-marks{display:flex;gap:28px;flex-wrap:wrap;margin-top:40px}' +
        '.h-mark{display:flex;align-items:center;gap:18px;width:330px;box-sizing:border-box;padding:22px 26px;background:#151a24;border:2px solid #232a39;' +
        'border-radius:20px;color:#e8ebf2;text-decoration:none;font-size:26px;font-weight:500;overflow:hidden;white-space:nowrap}' +
        '.h-mark:hover{border-color:#4f8cff;background:#1a2133}' +
        '.h-mark span{overflow:hidden;text-overflow:ellipsis}' +
        '.h-ico{flex:none;width:52px;height:52px;border-radius:14px;background:#2a3550;color:#fff;font-size:28px;font-weight:700;display:flex;align-items:center;justify-content:center}';

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function renderHome() {
        if (!isHome()) return;
        onReady(function () {
            document.title = 'Phone Browser';
            var style = document.getElementById('tvr-home-css');
            if (!style) {
                style = document.createElement('style');
                style.id = 'tvr-home-css';
                style.textContent = HOME_CSS;
                (document.head || document.documentElement).appendChild(style);
            }
            var info = homeInfo;
            var body = document.body || document.documentElement.appendChild(document.createElement('body'));
            var marks = '';
            if (info && info.bookmarks) {
                info.bookmarks.slice(0, 8).forEach(function (b) {
                    var letter = (b.title || b.url).replace(/^https?:\/\/(www\.)?/, '').charAt(0).toUpperCase();
                    marks += '<a class="h-mark" href="' + esc(b.url) + '"><div class="h-ico">' + esc(letter) + '</div><span>' + esc(b.title) + '</span></a>';
                });
            }
            var phones = info ? info.phones : 0;
            var statusText = !info ? 'Starting the remote service…'
                : phones ? phones + (phones === 1 ? ' phone connected' : ' phones connected')
                    : 'Waiting for your phone';
            body.innerHTML =
                '<div class="h-wrap"><div class="h-top"><div class="h-text">' +
                '<div class="h-brand">Phone Browser</div>' +
                '<h1 class="h-title">Browse with your phone</h1>' +
                '<ol class="h-steps"><li>Connect your phone to the same Wi‑Fi as the TV.</li>' +
                '<li>Scan the code, or open this address on your phone:<br><span class="h-url">' +
                esc(info ? info.url.replace(/^http:\/\//, '') : '…') + '</span></li>' +
                '<li>Enter the pairing code that appears on the TV.</li></ol>' +
                '<div class="h-status' + (phones ? ' ok' : '') + '"><i></i>' + esc(statusText) + '</div>' +
                '</div><div class="h-qr">' + (info ? info.qr : '') + '</div></div>' +
                '<div class="h-marks">' + marks + '</div></div>';
        });
    }

    // ------------------------------------------------------------------
    // Synthetic input (compatibility mode, no DevTools)

    function elAt(x, y) {
        return document.elementFromPoint(x, y);
    }

    function fire(el, type, x, y, opts) {
        opts = opts || {};
        var init = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: x, clientY: y, screenX: x, screenY: y,
            button: 0, buttons: opts.buttons || 0, detail: opts.detail || 0
        };
        var ev;
        if (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function') {
            init.pointerId = 1;
            init.pointerType = 'mouse';
            init.isPrimary = true;
            ev = new PointerEvent(type, init);
        } else if (type === 'wheel') {
            init.deltaX = opts.dx || 0;
            init.deltaY = opts.dy || 0;
            init.deltaMode = 0;
            ev = new WheelEvent(type, init);
        } else {
            ev = new MouseEvent(type, init);
        }
        return el.dispatchEvent(ev);
    }

    function syntheticHover(x, y) {
        var el = elAt(x, y);
        if (!el) return;
        if (el !== hoverEl) {
            if (hoverEl) {
                fire(hoverEl, 'pointerout', x, y);
                fire(hoverEl, 'mouseout', x, y);
            }
            fire(el, 'pointerover', x, y);
            fire(el, 'mouseover', x, y);
            hoverEl = el;
        }
        fire(el, 'pointermove', x, y);
        fire(el, 'mousemove', x, y);
    }

    function focusTarget(el) {
        if (!el.closest) return null;
        return el.closest('input,textarea,select,button,a[href],[tabindex],[contenteditable=""],[contenteditable="true"]');
    }

    function doClick(x, y, count) {
        setCursor(x, y, false);
        ripple(x, y);
        var el = elAt(x, y);
        if (!el) return;
        syntheticClicks++;
        try {
            clickSequence(el, x, y, count);
        } finally {
            syntheticClicks--;
        }
    }

    function clickSequence(el, x, y, count) {
        fire(el, 'pointerdown', x, y, { buttons: 1 });
        if (fire(el, 'mousedown', x, y, { buttons: 1, detail: count })) {
            var f = focusTarget(el);
            if (f && f.focus) f.focus();
            else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            // focus() fires no focusin while the window itself is unfocused.
            var described = describeFocus(document.activeElement);
            if (described) emit({ t: 'focus', focus: described });
        }
        fire(el, 'pointerup', x, y);
        fire(el, 'mouseup', x, y, { detail: count });
        fire(el, 'click', x, y, { detail: count });
        if (count === 2) fire(el, 'dblclick', x, y, { detail: 2 });
    }

    function mouseButton(x, y, down) {
        var el = elAt(x, y);
        if (!el) return;
        fire(el, down ? 'pointerdown' : 'pointerup', x, y, { buttons: down ? 1 : 0 });
        fire(el, down ? 'mousedown' : 'mouseup', x, y, { buttons: down ? 1 : 0, detail: 1 });
    }

    function canScroll(el, dx, dy) {
        var cs = getComputedStyle(el);
        if (dy && /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
            if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
        }
        if (dx && /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) {
            if (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
        }
        return false;
    }

    function doScroll(x, y, dx, dy) {
        var el = elAt(x, y);
        if (el && !fire(el, 'wheel', x, y, { dx: dx, dy: dy })) return; // page handled it
        for (var n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            if (canScroll(n, dx, dy)) {
                n.scrollLeft += dx;
                n.scrollTop += dy;
                return;
            }
        }
        window.scrollBy(dx, dy);
    }

    function keyEvent(target, type, key) {
        var code = KEYCODES[key] || 0;
        var ev = new KeyboardEvent(type, {
            key: key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true, composed: true
        });
        // keyCode/which can't be set through the constructor.
        try {
            Object.defineProperty(ev, 'keyCode', { get: function () { return code; } });
            Object.defineProperty(ev, 'which', { get: function () { return code; } });
        } catch (e) { /* read-only in this engine */ }
        return target.dispatchEvent(ev);
    }

    function isEditable(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
        if (el.tagName === 'INPUT') return TEXT_INPUT.test(el.type) && !el.disabled && !el.readOnly;
        return false;
    }

    function focusables() {
        return Array.prototype.filter.call(
            document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]'),
            function (el) { return el.tabIndex >= 0 && !el.disabled && el.offsetParent !== null; });
    }

    function submitForm(form) {
        if (form.requestSubmit) return form.requestSubmit();
        var btn = form.querySelector('[type=submit],button:not([type])');
        if (btn) return btn.click();
        var ev = document.createEvent('Event');
        ev.initEvent('submit', true, true);
        if (form.dispatchEvent(ev)) form.submit();
    }

    function doKey(key) {
        var t = document.activeElement || document.body;
        var ok = keyEvent(t, 'keydown', key);
        if (ok && (key === 'Enter' || key === ' ')) ok = keyEvent(t, 'keypress', key);
        if (ok) defaultKeyAction(t, key);
        keyEvent(t, 'keyup', key);
    }

    function defaultKeyAction(t, key) {
        var editable = isEditable(t);
        var page = window.innerHeight * 0.85;
        switch (key) {
            case 'Enter':
                if (t.tagName === 'TEXTAREA' || t.isContentEditable) document.execCommand('insertLineBreak');
                else if (t.form) submitForm(t.form);
                else if (t.click && !editable && t !== document.body) t.click();
                break;
            case 'Backspace':
                if (editable) document.execCommand('delete');
                break;
            case 'Delete':
                if (editable) document.execCommand('forwardDelete');
                break;
            case 'Tab': {
                var list = focusables();
                var next = list[(list.indexOf(t) + 1) % list.length];
                if (next) next.focus();
                break;
            }
            case ' ':
                if (editable) document.execCommand('insertText', false, ' ');
                else if (t.click && t !== document.body && /^(BUTTON|INPUT|A)$/.test(t.tagName)) t.click();
                else window.scrollBy(0, page);
                break;
            case 'ArrowDown': if (!editable) window.scrollBy(0, 80); break;
            case 'ArrowUp': if (!editable) window.scrollBy(0, -80); break;
            case 'PageDown': window.scrollBy(0, page); break;
            case 'PageUp': window.scrollBy(0, -page); break;
            case 'Home': if (!editable) window.scrollTo(0, 0); break;
            case 'End': if (!editable) window.scrollTo(0, document.documentElement.scrollHeight); break;
            case 'Escape':
                exitFullscreen();
                if (t.blur) t.blur();
                break;
            default:
                break;
        }
    }

    function goHistory(delta) {
        if (delta < 0 && isHome()) return emit({ t: 'notice', text: 'Already on the home screen' });
        history.go(delta);
    }

    // ------------------------------------------------------------------
    // Text fields and selects (used in both modes)

    function setNativeValue(el, value) {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
    }

    function setText(value) {
        var el = document.activeElement;
        if (!isEditable(el)) {
            emit({ t: 'notice', text: 'Click a text field on the TV first' });
            return false;
        }
        suppressValueEcho = true;
        if (el.isContentEditable) {
            document.execCommand('selectAll', false, null);
            if (value) document.execCommand('insertText', false, value);
            else document.execCommand('delete');
        } else if (el.value !== value) {
            try { el.select(); } catch (e) { /* not selectable */ }
            // execCommand keeps the edit "user-like" so frameworks (React…) notice it.
            var ok = false;
            try { ok = value ? document.execCommand('insertText', false, value) : document.execCommand('delete'); } catch (e) { ok = false; }
            if (!ok || el.value !== value) {
                setNativeValue(el, value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        suppressValueEcho = false;
        return true;
    }

    function setSelect(index) {
        var el = document.activeElement;
        if (!el || el.tagName !== 'SELECT') return false;
        el.selectedIndex = index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        emit({ t: 'focus', focus: describeFocus(el) });
        return true;
    }

    function labelFor(el) {
        var label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
        if (!label && el.id) {
            var l = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
            if (l) label = l.textContent;
        }
        return String(label || el.name || '').trim().substr(0, 80);
    }

    function describeFocus(el) {
        if (!el || el === document.body) return null;
        if (el.tagName === 'SELECT') {
            return {
                kind: 'select',
                label: labelFor(el),
                options: Array.prototype.map.call(el.options, function (o) { return o.text; }).slice(0, 500),
                selectedIndex: el.selectedIndex
            };
        }
        if (!isEditable(el)) return null;
        var type = el.tagName === 'TEXTAREA' ? 'textarea' : el.isContentEditable ? 'richtext' : (el.type || 'text');
        return {
            kind: 'text',
            label: labelFor(el),
            inputType: type,
            multiline: type === 'textarea' || type === 'richtext',
            // Passwords stay on the TV.
            value: type === 'password' ? '' : (el.isContentEditable ? el.innerText : el.value).substr(0, 5000)
        };
    }

    var blurTimer = null;
    var valueTimer = null;
    var suppressValueEcho = false;

    document.addEventListener('focusin', function (e) {
        clearTimeout(blurTimer);
        var focus = describeFocus(e.target);
        if (focus) emit({ t: 'focus', focus: focus });
    }, true);

    document.addEventListener('focusout', function () {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(function () {
            if (!describeFocus(document.activeElement)) emit({ t: 'blur' });
        }, 200);
    }, true);

    // Keep the phone's text box in sync when the page edits the field itself.
    document.addEventListener('input', function (e) {
        if (suppressValueEcho || e.target !== document.activeElement || !isEditable(e.target)) return;
        clearTimeout(valueTimer);
        valueTimer = setTimeout(function () {
            var f = describeFocus(document.activeElement);
            if (f && f.kind === 'text' && f.inputType !== 'password') emit({ t: 'value', value: f.value });
        }, 150);
    }, true);

    // Native <select> popups need the TV remote; let the phone pick instead.
    document.addEventListener('mousedown', function (e) {
        var t = e.target;
        if (t && t.tagName === 'SELECT' && !t.multiple) {
            e.preventDefault();
            t.focus();
            emit({ t: 'focus', focus: describeFocus(t) });
        }
    }, true);

    // ------------------------------------------------------------------
    // Zoom (per site, remembered in the site's localStorage)

    function getZoom() {
        try { return parseFloat(localStorage.getItem('__tvr_zoom')) || 1; } catch (e) { return 1; }
    }

    function applyZoom(z) {
        if (document.body) document.body.style.zoom = z === 1 ? '' : String(z);
    }

    function changeZoom(dir) {
        var z = getZoom();
        var i = 0;
        for (var k = 0; k < ZOOM_STEPS.length; k++) {
            if (Math.abs(ZOOM_STEPS[k] - z) < Math.abs(ZOOM_STEPS[i] - z)) i = k;
        }
        z = dir === 0 ? 1 : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + (dir > 0 ? 1 : -1)))];
        try { localStorage.setItem('__tvr_zoom', String(z)); } catch (e) { /* storage blocked */ }
        applyZoom(z);
        toast('Zoom ' + Math.round(z * 100) + '%');
        emit(pageInfo('page'));
    }

    // ------------------------------------------------------------------
    // Video helpers

    function bestVideo() {
        var best = null;
        var bestScore = -1;
        Array.prototype.forEach.call(document.querySelectorAll('video'), function (v) {
            var r = v.getBoundingClientRect();
            var score = r.width * r.height + (v.paused ? 0 : 1e9);
            if (r.width > 0 && score > bestScore) {
                best = v;
                bestScore = score;
            }
        });
        return best;
    }

    function exitFullscreen() {
        if (theater) {
            theater.el.style.cssText = theater.css;
            theater = null;
        }
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if ((document.fullscreenElement || document.webkitFullscreenElement) && exit) {
            try { exit.call(document); } catch (e) { /* ignore */ }
        }
    }

    function makeTheater(v) {
        theater = { el: v, css: v.style.cssText };
        v.style.cssText += ';position:fixed!important;left:0!important;top:0!important;width:100vw!important;' +
            'height:100vh!important;z-index:2147483646!important;background:#000!important;object-fit:contain!important';
    }

    function media(action, delta) {
        var v = bestVideo();
        if (!v) {
            emit({ t: 'notice', text: 'No video on this page' });
            return false;
        }
        if (action === 'toggle') {
            if (v.paused) {
                var p = v.play();
                if (p && p.catch) p.catch(function () { emit({ t: 'notice', text: 'The page blocked playback' }); });
            } else {
                v.pause();
            }
        } else if (action === 'seek') {
            v.currentTime = Math.max(0, v.currentTime + (delta || 0));
        } else if (action === 'fullscreen') {
            if (theater || document.fullscreenElement || document.webkitFullscreenElement) return exitFullscreen(), true;
            var req = v.requestFullscreen || v.webkitRequestFullscreen;
            var result = null;
            try { result = req ? req.call(v) : null; } catch (e) { result = null; }
            // Without a user gesture (compatibility mode) fullscreen is refused;
            // stretch the video over the page instead.
            if (result && result.catch) result.catch(function () { makeTheater(v); });
            else setTimeout(function () {
                if (!document.fullscreenElement && !document.webkitFullscreenElement) makeTheater(v);
            }, 300);
        }
        return true;
    }

    // ------------------------------------------------------------------
    // TV remote keys and single-window behaviour

    window.addEventListener('keydown', function (e) {
        if (e.defaultPrevented) return;
        var v;
        switch (e.keyCode) {
            case TV_KEYS.back:
                e.preventDefault();
                if (theater || document.fullscreenElement || document.webkitFullscreenElement) return exitFullscreen();
                // The service keeps Back inside the current tab. On the home
                // screen, or with no way to reach the service, Back works as usual
                // (from home it returns to TizenBrew).
                if (!isHome() && (socketOpen || Date.now() - lastDrain < 1500)) return emit({ t: 'remoteBack' });
                if (history.length > 1) return history.back();
                try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* not on a TV */ }
                break;
            case TV_KEYS.playPause:
            case TV_KEYS.play:
            case TV_KEYS.pause:
                v = bestVideo();
                if (!v) return;
                e.preventDefault();
                if (e.keyCode === TV_KEYS.pause || (e.keyCode === TV_KEYS.playPause && !v.paused)) v.pause();
                else v.play();
                break;
            case TV_KEYS.stop:
                v = bestVideo();
                if (v) v.pause();
                break;
            case TV_KEYS.rewind:
            case TV_KEYS.forward:
                v = bestVideo();
                if (v) v.currentTime = Math.max(0, v.currentTime + (e.keyCode === TV_KEYS.forward ? 10 : -10));
                break;
            default:
                break;
        }
    });

    installPopupGuards(function (kind, url) {
        emit({ t: kind, url: url });
    });

    // Frames report their links and pop-ups here (see guardFrame).
    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d !== 'object' || typeof d.url !== 'string' || !/^https?:/i.test(d.url)) return;
        if (d.__tvr !== 'open' && d.__tvr !== 'popup') return;
        // Only a real click (which also activates this page) may open a
        // foreground tab; anything else a frame sends is treated as a pop-up.
        var active = navigator.userActivation && navigator.userActivation.isActive;
        emit({ t: d.__tvr === 'open' && active ? 'open' : 'popup', url: d.url });
    });

    // ------------------------------------------------------------------
    // Page reporting

    function reportPage() {
        var info = pageInfo('page');
        var key = info.url + '|' + info.title + '|' + info.vw + 'x' + info.vh + '|' + info.zoom;
        if (key === lastPage) return;
        lastPage = key;
        emit(info);
    }

    setInterval(reportPage, 1000);
    window.addEventListener('resize', reportPage);

    onReady(function () {
        applyZoom(getZoom());
        if (isHome()) renderHome();
        var f = describeFocus(document.activeElement);
        if (f) emit({ t: 'focus', focus: f });
    });

    emit(pageInfo('hello'));
    connect();
})();
