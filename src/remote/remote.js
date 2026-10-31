(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const DEFAULTS = { speed: 1.6, scroll: 1.6, natural: true, search: 'google', haptics: true };
  const SEARCH = {
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
    ecosia: 'https://www.ecosia.org/search?q='
  };
  const MODE_TEXT = {
    cdp: ['ok', 'Direct control'],
    agent: ['warn', 'Compatibility mode'],
    none: ['', 'Open Phone Browser on the TV']
  };

  const saved = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('tvr.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem('tvr.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
  };

  const settings = Object.assign({}, DEFAULTS, saved.get('settings', {}));
  let token = saved.get('token', null);
  let ws = null;
  let retries = 0;
  let reconnectTimer = null;
  let state = { mode: 'none', focus: null, bookmarks: [], tabs: [], activeTab: null, url: '', home: true, vw: 1920, vh: 1080 };
  let screenOn = false;

  // ------------------------------------------------------------------
  // Connection

  function connect() {
    clearTimeout(reconnectTimer);
    if (!token) {
      setStatus('bad', 'Not paired');
      return showPairing();
    }
    if (ws && ws.readyState <= 1) return;
    setStatus('bad', 'Connecting…');
    const sock = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      retries = 0;
      if (screenOn) send({ t: 'screen', on: true });
    };
    sock.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handle(msg);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      if (e.code === 4001) {
        token = null;
        saved.set('token', null);
        setStatus('bad', 'Not paired');
        return showPairing();
      }
      setStatus('bad', 'Reconnecting…');
      reconnectTimer = setTimeout(connect, Math.min(5000, 400 * ++retries));
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  setInterval(() => send({ t: 'ping' }), 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) connect();
  });

  function handle(msg) {
    switch (msg.t) {
      case 'state': applyState(msg); break;
      case 'frame': showFrame(msg); break;
      case 'screen':
        if (!msg.supported) {
          setScreen(false);
          toast('Screen preview is not available right now');
        }
        break;
      case 'toast': toast(msg.text); break;
      case 'popup': showNotice(msg); break;
      default: break;
    }
  }

  function setStatus(level, text) {
    $('status').className = 'status ' + level;
    $('statusText').textContent = text;
  }

  // ------------------------------------------------------------------
  // State from the TV

  function sameFocus(a, b) {
    return !!a && !!b && a.kind === b.kind && a.label === b.label && a.inputType === b.inputType;
  }

  function applyState(next) {
    const prev = state;
    state = next;

    const m = MODE_TEXT[next.mode] || MODE_TEXT.none;
    setStatus(m[0], next.mode === 'none' || !next.title ? m[1] : `${m[1]} · ${next.title}`);

    if (document.activeElement !== $('url')) $('url').value = next.home ? '' : next.url;

    const bookmarked = next.bookmarks.some((b) => b.url === next.url);
    $('btnStar').classList.toggle('on', bookmarked);
    $('btnStar').disabled = next.home || !/^https?:/.test(next.url);

    applyFocus(prev.focus, next.focus);

    if (next.dialog) showDialog(next.dialog);
    else if (!$('dialogSheet').hidden) closeSheet('dialogSheet');

    if (!$('bookmarksSheet').hidden) renderBookmarks();
    $('tabCount').textContent = next.tabs.length > 99 ? '99+' : String(next.tabs.length);
    if (!$('tabsSheet').hidden) renderTabs();

    if (screenOn && next.mode !== 'cdp') {
      setScreen(false);
      toast('Screen preview needs direct control');
    }
  }

  let lastLocalEdit = 0;

  function applyFocus(prev, focus) {
    const kbd = $('kbd');
    const text = $('text');
    if (focus && focus.kind === 'text') {
      kbd.classList.add('active');
      $('focusLabel').textContent = 'Typing into: ' + (focus.label || focus.inputType);
      text.classList.toggle('secret', focus.inputType === 'password');
      if (!sameFocus(prev, focus)) {
        text.value = focus.value || '';
      } else if (Date.now() - lastLocalEdit > 1500 && text.value !== focus.value) {
        text.value = focus.value || '';
      }
      autoGrow();
    } else {
      kbd.classList.remove('active');
      text.classList.remove('secret');
      $('focusLabel').textContent = 'No text field selected on the TV';
      if (prev && prev.kind === 'text') {
        text.value = '';
        autoGrow();
      }
    }

    if (focus && focus.kind === 'select') {
      if (!sameFocus(prev, focus) || $('pickerSheet').hidden) showPicker(focus);
      else renderPicker(focus);
    } else if (!$('pickerSheet').hidden) {
      closeSheet('pickerSheet');
    }
  }

  // ------------------------------------------------------------------
  // Trackpad

  const pad = $('pad');
  const pointers = new Map();
  const acc = { mx: 0, my: 0, sx: 0, sy: 0 };
  let gesture = null;
  let lastTap = { time: -1e9, x: 0, y: 0 };
  let raf = 0;

  function queueFlush() {
    if (!raf) raf = requestAnimationFrame(flushPointer);
  }

  function flushPointer() {
    raf = 0;
    const mx = Math.trunc(acc.mx);
    const my = Math.trunc(acc.my);
    if (mx || my) {
      send({ t: 'move', dx: mx, dy: my });
      acc.mx -= mx;
      acc.my -= my;
    }
    const sx = Math.trunc(acc.sx);
    const sy = Math.trunc(acc.sy);
    if (sx || sy) {
      send({ t: 'scroll', dx: sx, dy: sy });
      acc.sx -= sx;
      acc.sy -= sy;
    }
  }

  function haptic() {
    if (settings.haptics && navigator.vibrate) navigator.vibrate(8);
  }

  function imageRect() {
    const img = $('screen');
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return null;
    const r = img.getBoundingClientRect();
    const scale = Math.min(r.width / iw, r.height / ih);
    const w = iw * scale;
    const h = ih * scale;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
  }

  function screenPoint(x, y) {
    const r = imageRect();
    if (!r) return null;
    const fx = (x - r.left) / r.w;
    const fy = (y - r.top) / r.h;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
    return { fx, fy };
  }

  pad.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    pad.classList.add('active');

    if (pointers.size === 1) {
      const inStrip = !screenOn && e.target.closest('.strip');
      gesture = {
        type: screenOn ? 'screen' : inStrip ? 'strip' : 'move',
        start: e.timeStamp,
        x0: e.clientX,
        y0: e.clientY,
        moved: false,
        dragging: false,
        // A second touch shortly after a tap turns into click-and-drag.
        dragArmed: !screenOn && !inStrip && e.timeStamp - lastTap.time < 280
      };
      if (gesture.type === 'screen') {
        const p = screenPoint(e.clientX, e.clientY);
        if (p) send({ t: 'moveTo', fx: p.fx, fy: p.fy });
        else gesture.type = 'ignore';
      }
    } else if (gesture && pointers.size === 2) {
      if (gesture.dragging) send({ t: 'up' });
      gesture.dragging = false;
      gesture.type = screenOn ? 'ignore' : 'scroll';
      gesture.moved = true;
    }
  });

  pad.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p || !gesture) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    const dt = Math.max(1, e.timeStamp - p.t);
    p.x = e.clientX;
    p.y = e.clientY;
    p.t = e.timeStamp;

    if (!gesture.moved && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 6) {
      gesture.moved = true;
      if (gesture.dragArmed && gesture.type === 'move') {
        gesture.dragging = true;
        send({ t: 'down' });
        haptic();
      }
    }

    const dir = settings.natural ? -1 : 1;
    switch (gesture.type) {
      case 'move': {
        // Pointer acceleration: slow moves stay precise, fast flicks cross the TV.
        const velocity = Math.hypot(dx, dy) / dt;
        const gain = settings.speed * (1 + Math.min(velocity, 2.5) * 1.2);
        acc.mx += dx * gain;
        acc.my += dy * gain;
        break;
      }
      case 'scroll':
        acc.sx += (dx / pointers.size) * settings.scroll * 2 * dir;
        acc.sy += (dy / pointers.size) * settings.scroll * 2 * dir;
        break;
      case 'strip':
        acc.sy += dy * settings.scroll * 4 * dir;
        break;
      case 'screen':
        if (gesture.moved) {
          const r = imageRect();
          const scale = r ? (state.vw || 1920) / r.w : 2;
          acc.sx -= dx * scale;
          acc.sy -= dy * scale;
        }
        break;
      default:
        break;
    }
    queueFlush();
  });

  function endPointer(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size > 0 || !gesture) return;
    pad.classList.remove('active');
    flushPointer();
    const g = gesture;
    gesture = null;
    if (g.dragging) return send({ t: 'up' });
    if (cancelled || g.moved) return;
    if ((g.type === 'move' || g.type === 'screen') && e.timeStamp - g.start < 350) {
      const now = e.timeStamp;
      const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
      const double = now - lastTap.time < 320 && (g.type === 'move' || near);
      send({ t: 'click', count: double ? 2 : 1 });
      haptic();
      lastTap = double ? { time: -1e9, x: 0, y: 0 } : { time: now, x: e.clientX, y: e.clientY };
    }
  }

  pad.addEventListener('pointerup', (e) => endPointer(e, false));
  pad.addEventListener('pointercancel', (e) => endPointer(e, true));
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  // Mouse wheel / laptop trackpad, for using a computer as the remote.
  pad.addEventListener('wheel', (e) => {
    e.preventDefault();
    acc.sx += e.deltaX;
    acc.sy += e.deltaY;
    queueFlush();
  }, { passive: false });

  // ------------------------------------------------------------------
  // Screen preview

  function setScreen(on) {
    if (on && state.mode !== 'cdp') {
      toast('Screen preview needs direct control');
      on = false;
    }
    screenOn = on;
    pad.classList.toggle('screen-mode', on);
    $('btnScreen').classList.toggle('on', on);
    send({ t: 'screen', on });
    if (!on) $('screen').removeAttribute('src');
  }

  function showFrame(msg) {
    const img = $('screen');
    img.onload = img.onerror = () => send({ t: 'frameAck' });
    img.src = 'data:image/jpeg;base64,' + msg.data;
  }

  $('btnScreen').addEventListener('click', () => setScreen(!screenOn));

  // ------------------------------------------------------------------
  // Address bar and toolbar

  function toUrl(input) {
    const q = input.trim();
    if (!q) return null;
    if (/^https?:\/\//i.test(q)) return q;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(q)) return 'http://' + q;
    if (!/\s/.test(q) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(q)) return 'https://' + q;
    return (SEARCH[settings.search] || SEARCH.google) + encodeURIComponent(q);
  }

  $('urlForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = toUrl($('url').value);
    if (!url) return;
    send({ t: 'nav', url });
    $('url').blur();
  });
  $('url').addEventListener('focus', () => setTimeout(() => $('url').select(), 0));

  document.querySelectorAll('[data-cmd]').forEach((b) => {
    b.addEventListener('click', () => send({ t: b.dataset.cmd }));
  });
  document.querySelectorAll('[data-zoom]').forEach((b) => {
    b.addEventListener('click', () => send({ t: 'zoom', dir: Number(b.dataset.zoom) }));
  });
  document.querySelectorAll('[data-media]').forEach((b) => {
    b.addEventListener('click', () => send({ t: 'media', action: b.dataset.media, delta: Number(b.dataset.delta || 0) }));
  });

  $('btnStar').addEventListener('click', () => {
    if ($('btnStar').classList.contains('on')) {
      send({ t: 'bookmarkRemove', url: state.url });
      toast('Bookmark removed');
    } else {
      send({ t: 'bookmarkAdd', url: state.url, title: state.title });
      toast('Bookmarked');
    }
  });

  // ------------------------------------------------------------------
  // Keyboard

  const text = $('text');
  let textTimer = null;

  function autoGrow() {
    text.style.height = 'auto';
    text.style.height = Math.min(96, text.scrollHeight + 2) + 'px';
  }

  function sendText() {
    clearTimeout(textTimer);
    send({ t: 'text', value: text.value });
  }

  text.addEventListener('input', () => {
    lastLocalEdit = Date.now();
    autoGrow();
    clearTimeout(textTimer);
    textTimer = setTimeout(sendText, 60);
  });

  text.addEventListener('keydown', (e) => {
    const multiline = state.focus && state.focus.multiline;
    if (e.key === 'Enter' && !e.shiftKey && !multiline && !e.isComposing) {
      e.preventDefault();
      sendText();
      send({ t: 'key', key: 'Enter' });
    }
  });

  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendText();
    send({ t: 'key', key: 'Enter' });
  });

  $('btnClear').addEventListener('click', () => {
    text.value = '';
    lastLocalEdit = Date.now();
    autoGrow();
    sendText();
  });

  document.querySelectorAll('[data-key]').forEach((b) => {
    b.addEventListener('click', () => send({ t: 'key', key: b.dataset.key }));
  });

  $('btnKeys').addEventListener('click', () => {
    const keys = $('keys');
    keys.hidden = !keys.hidden;
    $('btnKeys').classList.toggle('on', !keys.hidden);
  });

  // ------------------------------------------------------------------
  // Sheets

  function openSheet(id) {
    document.querySelectorAll('.sheet').forEach((s) => {
      if (s.id !== id && s.id !== 'pairSheet') s.hidden = true;
    });
    $(id).hidden = false;
    $('backdrop').hidden = false;
  }

  function closeSheet(id) {
    $(id).hidden = true;
    const anyOpen = Array.from(document.querySelectorAll('.sheet')).some((s) => !s.hidden);
    if (!anyOpen) $('backdrop').hidden = true;
  }

  $('backdrop').addEventListener('click', () => {
    document.querySelectorAll('.sheet').forEach((s) => {
      if (s.id !== 'pairSheet' && s.id !== 'dialogSheet' && !s.hidden) closeSheet(s.id);
    });
  });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closeSheet(b.closest('.sheet').id));
  });

  // Pairing

  function deviceName() {
    const ua = navigator.userAgent;
    const m = ua.match(/iPhone|iPad|Android|Macintosh|Windows|Linux/);
    return m ? m[0].replace('Macintosh', 'Mac') : 'Phone';
  }

  function showPairing() {
    $('pin').value = '';
    $('pairError').textContent = '';
    openSheet('pairSheet');
    requestPin();
  }

  function requestPin() {
    $('pairHint').textContent = '';
    fetch('/api/pair/start', { method: 'POST' })
      .then((r) => r.json())
      .then((j) => {
        $('pairHint').textContent = j.shown
          ? 'The code is now showing on the TV.'
          : 'Open “Phone Browser” in TizenBrew on the TV, then tap “Show the code on the TV again”.';
      })
      .catch(() => { $('pairHint').textContent = 'Cannot reach the TV. Check that the phone is on the same Wi‑Fi.'; });
  }

  function pair() {
    const pin = $('pin').value.trim();
    if (!/^\d{4}$/.test(pin)) {
      $('pairError').textContent = 'The code has 4 digits.';
      return;
    }
    $('btnPair').disabled = true;
    fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, name: deviceName() })
    })
      .then((r) => r.json())
      .then((j) => {
        if (j.token) {
          token = j.token;
          saved.set('token', token);
          closeSheet('pairSheet');
          toast('Paired');
          connect();
          return;
        }
        $('pin').value = '';
        if (j.error === 'wrong') {
          $('pairError').textContent = 'Wrong code, try again.';
        } else {
          $('pairError').textContent = j.error === 'locked' ? 'Too many attempts. A new code is on the TV.' : 'The code expired. A new one is on the TV.';
          requestPin();
        }
      })
      .catch(() => { $('pairError').textContent = 'Cannot reach the TV.'; })
      .then(() => { $('btnPair').disabled = false; });
  }

  $('btnPair').addEventListener('click', pair);
  $('btnPinAgain').addEventListener('click', requestPin);
  $('pin').addEventListener('input', () => {
    $('pin').value = $('pin').value.replace(/\D/g, '').slice(0, 4);
    if ($('pin').value.length === 4) pair();
  });

  // JavaScript dialogs (alert / confirm / prompt)

  let dialogKey = '';
  function showDialog(d) {
    const key = d.type + '|' + d.message;
    if (key === dialogKey && !$('dialogSheet').hidden) return;
    dialogKey = key;
    $('dlgTitle').textContent = d.type === 'beforeunload' ? 'Leave this page?' : 'The page says';
    $('dlgMsg').textContent = d.message;
    $('dlgInput').hidden = d.type !== 'prompt';
    $('dlgInput').value = d.defaultPrompt || '';
    $('dlgCancel').hidden = d.type === 'alert';
    $('dlgCancel').textContent = d.type === 'beforeunload' ? 'Stay' : 'Cancel';
    $('dlgOk').textContent = d.type === 'beforeunload' ? 'Leave' : 'OK';
    openSheet('dialogSheet');
  }

  function answerDialog(accept) {
    send({ t: 'dialog', accept, text: $('dlgInput').value });
    dialogKey = '';
    closeSheet('dialogSheet');
  }
  $('dlgOk').addEventListener('click', () => answerDialog(true));
  $('dlgCancel').addEventListener('click', () => answerDialog(false));

  // <select> picker

  function renderPicker(focus) {
    $('pickerTitle').textContent = focus.label || 'Choose an option';
    const list = $('pickerList');
    list.textContent = '';
    focus.options.forEach((label, i) => {
      const b = document.createElement('button');
      b.className = 'item' + (i === focus.selectedIndex ? ' sel' : '');
      b.textContent = label || '—';
      b.addEventListener('click', () => {
        send({ t: 'select', index: i });
        closeSheet('pickerSheet');
      });
      list.appendChild(b);
    });
  }

  function showPicker(focus) {
    renderPicker(focus);
    openSheet('pickerSheet');
    const sel = $('pickerList').querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'center' });
  }

  // Tabs

  function renderTabs() {
    const list = $('tabList');
    list.textContent = '';
    state.tabs.forEach((tab) => {
      const row = document.createElement('div');
      row.className = 'item' + (tab.id === state.activeTab ? ' sel' : '');
      row.setAttribute('role', 'button');
      const ico = document.createElement('div');
      ico.className = 'ico';
      ico.textContent = tab.url ? tab.url.replace(/^https?:\/\/(www\.)?/, '').charAt(0).toUpperCase() : '⌂';
      const grow = document.createElement('div');
      grow.className = 'grow';
      grow.textContent = tab.title || 'Untitled';
      const small = document.createElement('small');
      small.textContent = tab.url ? tab.url.replace(/^https?:\/\/(www\.)?/, '') : 'Home screen';
      grow.appendChild(small);
      const close = document.createElement('button');
      close.className = 'remove';
      close.setAttribute('aria-label', 'Close tab');
      close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ t: 'tabClose', id: tab.id });
      });
      row.addEventListener('click', () => {
        send({ t: 'tabSwitch', id: tab.id });
        closeSheet('tabsSheet');
      });
      row.append(ico, grow, close);
      list.appendChild(row);
    });
    $('btnCloseOthers').hidden = state.tabs.length < 2;
  }

  $('btnTabs').addEventListener('click', () => {
    renderTabs();
    openSheet('tabsSheet');
  });

  $('btnNewTab').addEventListener('click', () => {
    send({ t: 'tabNew' });
    closeSheet('tabsSheet');
    $('url').value = '';
    $('url').focus();
  });

  $('btnCloseOthers').addEventListener('click', () => send({ t: 'tabCloseOthers' }));

  // Pop-up notices

  let noticeTimer = null;

  function hideNotice() {
    $('notice').hidden = true;
  }

  function showNotice(msg) {
    const text = $('noticeText');
    const host = document.createElement('b');
    host.textContent = msg.host;
    text.textContent = '';
    text.append(msg.blocked ? 'Pop-up blocked: ' : 'Pop-up kept in a background tab: ', host);

    const actions = $('noticeActions');
    actions.textContent = '';
    const action = (label, primary, cmd) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.addEventListener('click', () => {
        send(cmd);
        hideNotice();
      });
      actions.appendChild(b);
    };
    if (msg.blocked) {
      action('Open', true, { t: 'tabOpen', url: msg.url });
    } else {
      action('Show', true, { t: 'tabSwitch', id: msg.tabId });
      action('Close', false, { t: 'tabClose', id: msg.tabId });
    }
    $('notice').hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, 10000);
  }

  // Bookmarks

  function renderBookmarks() {
    const list = $('bookmarkList');
    list.textContent = '';
    if (!state.bookmarks.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'No bookmarks yet. Use the star to save the page on the TV.';
      list.appendChild(p);
      return;
    }
    state.bookmarks.forEach((bm) => {
      const row = document.createElement('div');
      row.className = 'item';
      row.setAttribute('role', 'button');
      const grow = document.createElement('div');
      grow.className = 'grow';
      grow.textContent = bm.title;
      const small = document.createElement('small');
      small.textContent = bm.url.replace(/^https?:\/\/(www\.)?/, '');
      grow.appendChild(small);
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.setAttribute('aria-label', 'Remove bookmark');
      remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ t: 'bookmarkRemove', url: bm.url });
      });
      row.addEventListener('click', () => {
        send({ t: 'nav', url: bm.url });
        closeSheet('bookmarksSheet');
      });
      row.append(grow, remove);
      list.appendChild(row);
    });
  }

  $('btnBookmarks').addEventListener('click', () => {
    renderBookmarks();
    openSheet('bookmarksSheet');
  });

  // Settings

  function saveSettings() {
    saved.set('settings', settings);
  }

  function syncSettingsUi() {
    $('setSpeed').value = settings.speed;
    $('setScroll').value = settings.scroll;
    $('speedOut').textContent = Number(settings.speed).toFixed(1) + '×';
    $('scrollOut').textContent = Number(settings.scroll).toFixed(1) + '×';
    $('setNatural').checked = settings.natural;
    $('setHaptics').checked = settings.haptics;
    $('setSearch').value = settings.search;
    $('setPopups').value = state.blockPopups ? 'block' : 'tab';
    $('hapticsRow').hidden = !navigator.vibrate;
    $('version').textContent = 'Phone Browser ' + (state.version || '');
  }

  $('setSpeed').addEventListener('input', (e) => { settings.speed = Number(e.target.value); syncSettingsUi(); saveSettings(); });
  $('setScroll').addEventListener('input', (e) => { settings.scroll = Number(e.target.value); syncSettingsUi(); saveSettings(); });
  $('setNatural').addEventListener('change', (e) => { settings.natural = e.target.checked; saveSettings(); });
  $('setHaptics').addEventListener('change', (e) => { settings.haptics = e.target.checked; saveSettings(); });
  $('setSearch').addEventListener('change', (e) => { settings.search = e.target.value; saveSettings(); });
  // Stored on the TV: it applies to every paired phone.
  $('setPopups').addEventListener('change', (e) => send({ t: 'setting', key: 'blockPopups', value: e.target.value === 'block' }));

  $('btnSettings').addEventListener('click', () => {
    syncSettingsUi();
    $('diag').hidden = true;
    openSheet('settingsSheet');
  });

  $('btnDiag').addEventListener('click', () => {
    const out = $('diag');
    out.hidden = false;
    out.textContent = 'Loading…';
    Promise.all([
      fetch('/api/status').then((r) => r.json()),
      fetch('/api/logs?token=' + encodeURIComponent(token || '')).then((r) => r.json()).catch(() => ({ lines: [] }))
    ]).then(([status, logs]) => {
      out.textContent = JSON.stringify(status, null, 2) + '\n\n' + (logs.lines || []).join('\n');
    }).catch((e) => { out.textContent = 'Failed: ' + e.message; });
  });

  $('btnForget').addEventListener('click', () => {
    closeSheet('settingsSheet');
    send({ t: 'forget' });
  });

  $('btnForgetAll').addEventListener('click', () => {
    if (confirm('Unpair every phone from this TV? Each one will need the pairing code again.')) {
      closeSheet('settingsSheet');
      send({ t: 'forgetAll' });
    }
  });

  // ------------------------------------------------------------------
  // Misc

  let toastTimer = null;
  function toast(textValue) {
    const t = $('toast');
    t.textContent = textValue;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
  }

  // Keep the layout above the on-screen keyboard.
  function fitViewport() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', h + 'px');
    window.scrollTo(0, 0);
  }
  (window.visualViewport || window).addEventListener('resize', fitViewport);
  fitViewport();

  connect();
})();
