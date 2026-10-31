// End-to-end test against a headless Chrome standing in for the TV.
//   node test/e2e.mjs cdp     direct control over DevTools
//   node test/e2e.mjs agent   compatibility mode (no DevTools for the service)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    root, SERVICE_PORT, PAGES_PORT, CHROME_PORT, MENU_URL, startService, startPages, launchChrome,
    getJson, postJson, inspector, phone, waitFor, sleep
} from './tv-sim.mjs';

const mode = process.argv[2] === 'agent' ? 'agent' : 'cdp';
const base = `http://127.0.0.1:${SERVICE_PORT}`;
const pages = `http://127.0.0.1:${PAGES_PORT}`;
const dataDir = path.join(root, 'test/.data');
fs.mkdirSync(dataDir, { recursive: true });
const dataFile = path.join(dataDir, `store-${mode}.json`);
fs.rmSync(dataFile, { force: true });

let failures = 0;
async function step(name, fn) {
    try {
        await fn();
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL  ${name}: ${e.message}`);
        if (p && p.state) {
            const { url, title, mode: m, focus, dialog } = p.state;
            console.log('        phone state:', JSON.stringify({ url, title, mode: m, focus, dialog }));
            console.log('        last toasts:', JSON.stringify(p.messages.filter((x) => x.t === 'toast').slice(-3)));
        }
    }
}

const pageServer = await startPages();
const chrome = await launchChrome(path.join(os.tmpdir(), `tvr-chrome-${mode}`), MENU_URL);
startService({
    dataFile,
    testPin: '4321',
    cdpEndpoints: mode === 'cdp' ? [{ host: '127.0.0.1', port: CHROME_PORT }] : []
});
const tv = await inspector({ tizenBrew: true });
let p;

console.log(`Phone Browser e2e (${mode} mode)`);

try {
    if (mode === 'cdp') {
        await step('stays out of the way while the TizenBrew menu is open', () =>
            waitFor(async () => (await getJson(`${base}/api/status`)).mode === 'away', 'away'));
    }
    await tv.launchPhoneBrowser();

    await step(`service reports ${mode} mode`, () =>
        waitFor(async () => (await getJson(`${base}/api/status`)).mode === mode, 'mode'));

    await step('TV home shows the phone address and QR code', () =>
        waitFor(() => tv.eval(`!!document.querySelector('.h-qr svg') && document.querySelector('.h-url').textContent.includes(':${SERVICE_PORT}')`), 'home screen'));

    let token;
    await step('pairing rejects a wrong code and accepts the right one', async () => {
        const start = await postJson(`${base}/api/pair/start`);
        if (!start.body.shown) throw new Error('code not shown on TV');
        await waitFor(() => tv.eval(`(function(){var h=document.querySelector('tvr-overlay');return !!h})()`), 'pin overlay');
        const wrong = await postJson(`${base}/api/pair`, { pin: '0000' });
        if (wrong.status !== 403) throw new Error('wrong pin accepted');
        const right = await postJson(`${base}/api/pair`, { pin: '4321', name: 'test' });
        if (!right.body.token) throw new Error('no token');
        token = right.body.token;
    });

    await step('unpaired phones are refused', async () => {
        const bad = await phone('nope');
        await waitFor(() => bad.messages.some((m) => m.t === 'auth' && m.ok === false), 'auth refusal');
    });

    p = await phone(token);
    const px = (x, y) => ({ fx: x / p.state.vw, fy: y / p.state.vh });
    const clickAt = async (x, y) => {
        p.send({ t: 'moveTo', ...px(x, y) });
        await sleep(60);
        p.send({ t: 'click', count: 1 });
        await sleep(150);
    };

    await step('phone receives state', () => waitFor(() => p.state && p.state.mode === mode, 'state'));

    await step('navigate to a page', async () => {
        p.send({ t: 'nav', url: `${pages}/test.html` });
        await waitFor(() => p.state.url.includes('test.html') && p.state.title === 'Test page', 'test page');
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent on page');
    });

    await step('tap clicks a button', async () => {
        await clickAt(140, 80);
        await waitFor(async () => (await tv.eval(`document.getElementById('counter').textContent`)) === 'Clicked 1', 'counter = 1');
    });

    await step('relative pointer moves land where expected', async () => {
        p.send({ t: 'moveTo', ...px(100, 100) });
        p.send({ t: 'move', dx: 40, dy: -20 });
        await sleep(60);
        p.send({ t: 'click', count: 1 });
        await waitFor(async () => (await tv.eval(`document.getElementById('counter').textContent`)) === 'Clicked 2', 'counter = 2');
    });

    await step('focusing a text field opens the phone keyboard', async () => {
        await clickAt(450, 60);
        await waitFor(() => p.state.focus && p.state.focus.kind === 'text' && p.state.focus.label === 'Search box', 'text focus');
    });

    await step('typing on the phone fills the TV field', async () => {
        p.send({ t: 'text', value: 'hello' });
        p.send({ t: 'text', value: 'hello world' });
        await waitFor(async () => (await tv.eval(`document.getElementById('q').value`)) === 'hello world', 'q value');
    });

    await step('Enter submits the form', async () => {
        p.send({ t: 'key', key: 'Enter' });
        await waitFor(() => p.state.url.includes('submitted.html?q=hello+world'), 'form submit');
    });

    await step('back returns to the previous page', async () => {
        p.send({ t: 'back' });
        await waitFor(() => p.state.url.endsWith('test.html'), 'back');
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent after back');
    });

    await step('selects open a picker on the phone and apply the choice', async () => {
        await clickAt(400, 140);
        await waitFor(() => p.state.focus && p.state.focus.kind === 'select' && p.state.focus.options.length === 3, 'select focus');
        p.send({ t: 'select', index: 2 });
        await waitFor(async () => (await tv.eval(`document.getElementById('color').value`)) === 'Blue', 'select value');
    });

    await step('scrolling inside a scrollable box', async () => {
        p.send({ t: 'moveTo', ...px(450, 275) });
        await sleep(60);
        p.send({ t: 'scroll', dx: 0, dy: 300 });
        await waitFor(async () => (await tv.eval(`document.getElementById('box').scrollTop`)) > 50, 'box scrolled');
    });

    await step('scrolling the page', async () => {
        p.send({ t: 'moveTo', ...px(1400, 700) });
        await sleep(60);
        p.send({ t: 'scroll', dx: 0, dy: 500 });
        await waitFor(async () => (await tv.eval('window.scrollY')) > 100, 'page scrolled');
        await tv.eval('window.scrollTo(0, 0)');
    });

    await step('textarea edits made on the TV flow back to the phone', async () => {
        await clickAt(800, 90);
        await waitFor(() => p.state.focus && p.state.focus.multiline, 'textarea focus');
        p.send({ t: 'text', value: 'line1' });
        await sleep(100);
        p.send({ t: 'key', key: 'Enter' });
        await waitFor(() => p.state.focus && /^line1\n/.test(p.state.focus.value), 'value echo with newline');
    });

    await step('zoom in and reset', async () => {
        p.send({ t: 'zoom', dir: 1 });
        await waitFor(async () => (await tv.eval('document.body.style.zoom')) === '1.1', 'zoom 1.1');
        await waitFor(() => p.state.zoom === 1.1, 'zoom reported');
        p.send({ t: 'zoom', dir: 0 });
        await waitFor(async () => (await tv.eval('document.body.style.zoom')) === '', 'zoom reset');
    });

    await step('media without a video tells the phone', async () => {
        p.send({ t: 'media', action: 'toggle' });
        await waitFor(() => p.messages.some((m) => m.t === 'toast' && /No video/.test(m.text)), 'toast');
    });

    if (mode === 'cdp') {
        await step('confirm() dialogs are answered from the phone', async () => {
            await clickAt(140, 190);
            await waitFor(() => p.state.dialog && p.state.dialog.type === 'confirm', 'dialog state');
            p.send({ t: 'dialog', accept: true });
            await waitFor(async () => (await tv.eval('window.confirmResult')) === true, 'confirm result');
        });

        await step('screen preview streams frames', async () => {
            p.send({ t: 'screen', on: true });
            const frame = await waitFor(() => p.messages.find((m) => m.t === 'frame'), 'frame');
            if (frame.data.length < 1000) throw new Error('frame too small');
            p.send({ t: 'frameAck' });
            p.send({ t: 'screen', on: false });
        });
    }

    if (mode === 'cdp') {
        await step('pages whose CSP blocks the agent socket still report focus', async () => {
            p.send({ t: 'nav', url: `${pages}/csp.html` });
            await waitFor(() => p.state.title === 'CSP page', 'csp page');
            await sleep(1500);
            if ((await getJson(`${base}/api/status`)).agentConnected) throw new Error('agent socket was not blocked');
            await clickAt(450, 60);
            await waitFor(() => p.state.focus && p.state.focus.label === 'Search box', 'focus via polling');
            p.send({ t: 'text', value: 'csp ok' });
            await waitFor(async () => (await tv.eval(`document.getElementById('q').value`)) === 'csp ok', 'text via DevTools');
            p.send({ t: 'nav', url: `${pages}/test.html` });
            await waitFor(() => p.state.title === 'Test page', 'back to test page');
        });
    }

    const pageTargets = async () => (await getJson(`http://127.0.0.1:${CHROME_PORT}/json/list`)).filter((t) => t.type === 'page').length;
    const activeTab = () => p.state.tabs.find((t) => t.id === p.state.activeTab);
    const popupNotice = (fragment) => p.messages.find((m) => m.t === 'popup' && m.url.includes(fragment));

    await step('new-tab links open as a new tab in the same window', async () => {
        await clickAt(100, 272);
        await waitFor(() => p.state.tabs.length === 2 && activeTab().url.includes('from=blank') && p.state.url.includes('from=blank'), 'new active tab');
        if (await pageTargets() !== 1) throw new Error('a second window was opened');
    });

    if (mode === 'cdp') {
        await step('Back on the first page of a new tab closes it and returns', async () => {
            p.send({ t: 'back' });
            await waitFor(() => p.state.tabs.length === 1 && p.state.url.endsWith('test.html'), 'tab closed, opener shown');
        });
    } else {
        await step('Back goes back in the window (compatibility mode)', async () => {
            p.send({ t: 'back' });
            await waitFor(() => p.state.url.endsWith('test.html'), 'back');
            p.send({ t: 'tabCloseOthers' });
            await waitFor(() => p.state.tabs.length === 1, 'one tab');
        });
    }
    await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');

    await step('script pop-ups become background tabs and notify the phone', async () => {
        await clickAt(120, 445);
        await waitFor(() => popupNotice('from=popup') && p.state.tabs.length === 2, 'background tab');
        if (!p.state.url.endsWith('test.html')) throw new Error('pop-up took over the screen');
        if (popupNotice('from=popup').blocked) throw new Error('reported as blocked');
        if (await pageTargets() !== 1) throw new Error('a second window was opened');
    });

    await step('pop-unders from links never added to the page are caught', async () => {
        await clickAt(300, 445);
        await waitFor(() => popupNotice('from=popunder') && p.state.tabs.length === 3, 'pop-under tab');
        if (!p.state.url.endsWith('test.html')) throw new Error('pop-under took over the screen');
    });

    await step('pop-ups from frames are caught', async () => {
        await tv.eval(`document.getElementById('frame').contentWindow.open('/submitted.html?from=frame'), true`);
        await waitFor(() => popupNotice('from=frame') && p.state.tabs.length === 4, 'frame pop-up tab');
        if (await pageTargets() !== 1) throw new Error('a second window was opened');
    });

    if (mode === 'cdp') {
        await step('windows that slip past the agent are closed and kept as tabs', async () => {
            await clickAt(480, 445);
            await waitFor(() => popupNotice('from=form') && p.state.tabs.length === 5, 'form pop-up tab');
            await waitFor(async () => (await pageTargets()) === 1, 'stray window closed');
            if (!p.state.url.endsWith('test.html')) throw new Error('form pop-up took over the screen');
        });
    }

    await step('repeated pop-ups are not duplicated', async () => {
        const before = p.state.tabs.length;
        p.messages.length = 0;
        await clickAt(120, 445);
        await sleep(800);
        if (p.state.tabs.length !== before) throw new Error('duplicate tab');
    });

    await step('a burst of pop-ups is cut off', async () => {
        p.send({ t: 'tabCloseOthers' });
        await waitFor(() => p.state.tabs.length === 1, 'one tab');
        await sleep(10000); // let the earlier pop-ups age out of the 10 s window
        await tv.eval(`for (var i = 0; i < 10; i++) window.open('/submitted.html?flood=' + i); true`);
        await waitFor(() => p.messages.filter((m) => m.t === 'popup' && m.url.includes('flood=')).length === 10, '10 notices');
        await sleep(300);
        if (p.state.tabs.length !== 6) throw new Error(`${p.state.tabs.length - 1} pop-up tabs kept, expected 5`);
    });

    await step('switching to a background tab loads it', async () => {
        const firstTab = p.state.activeTab;
        p.send({ t: 'tabCloseOthers' });
        await sleep(10000);
        await clickAt(120, 445);
        await waitFor(() => p.state.tabs.some((t) => t.url.includes('from=popup')), 'pop-up tab');
        const popupTab = p.state.tabs.find((t) => t.url.includes('from=popup'));
        p.send({ t: 'tabSwitch', id: popupTab.id });
        await waitFor(() => p.state.activeTab === popupTab.id && p.state.url.includes('from=popup'), 'switched');
        await sleep(300);
        if (!activeTab().url.includes('from=popup')) throw new Error('tab address overwritten');
        if (!p.state.tabs.find((t) => t.id === firstTab).url.endsWith('test.html')) throw new Error('first tab lost its address');
        if (mode === 'cdp') {
            p.send({ t: 'back' });
            await waitFor(() => p.state.activeTab === firstTab && p.state.url.endsWith('test.html'), 'Back returned to the opener');
            if (p.state.tabs.some((t) => t.id === popupTab.id)) throw new Error('pop-up tab not closed');
        } else {
            p.send({ t: 'tabSwitch', id: firstTab });
            await waitFor(() => p.state.activeTab === firstTab && p.state.url.endsWith('test.html'), 'switched back');
        }
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');
    });

    await step('pop-ups can be blocked instead', async () => {
        p.send({ t: 'tabCloseOthers' });
        p.send({ t: 'setting', key: 'blockPopups', value: true });
        await waitFor(() => p.state.blockPopups && p.state.tabs.length === 1, 'setting on');
        p.messages.length = 0;
        await clickAt(120, 445);
        await waitFor(() => popupNotice('from=popup') && popupNotice('from=popup').blocked, 'blocked notice');
        await sleep(300);
        if (p.state.tabs.length !== 1) throw new Error('tab created while blocking');
        p.send({ t: 'setting', key: 'blockPopups', value: false });
        await waitFor(() => !p.state.blockPopups, 'setting off');
    });

    await step('the TV remote Back key goes back', async () => {
        p.send({ t: 'nav', url: `${pages}/submitted.html?from=remote` });
        await waitFor(() => p.state.url.includes('from=remote'), 'navigated');
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');
        await sleep(300);
        const keyEvent = { windowsVirtualKeyCode: 10009, nativeVirtualKeyCode: 10009, key: 'GoBack', code: 'BrowserBack' };
        await tv.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent });
        await tv.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent });
        await waitFor(() => p.state.url.endsWith('test.html'), 'back via remote');
    });

    await step('Back to TizenBrew returns to the TizenBrew menu', async () => {
        p.send({ t: 'nav', url: `${pages}/test.html?last=1` }); // newest history entry, see compatibility-mode exit
        await waitFor(() => p.state.url.endsWith('test.html?last=1'), 'test page');
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');
        p.send({ t: 'exit' });
        await waitFor(async () => (await tv.eval('location.pathname')).includes('/tizenbrew-ui/'), 'TizenBrew menu');
        await waitFor(() => p.state.mode === (mode === 'cdp' ? 'away' : 'none') && p.state.url === '', 'phone shows away');
    });

    if (mode === 'cdp') {
        await step('other TizenBrew apps are left alone', async () => {
            tv.injectAgent = false; // TizenBrew now injects the other app's script, not ours
            await tv.send('Page.navigate', { url: `${pages}/submitted.html?from=otherapp` });
            await waitFor(async () => (await tv.eval('location.search')) === '?from=otherapp', 'other app page');
            await sleep(1500);
            if (await tv.eval('!!window.__tvr')) throw new Error('agent injected into another app');
            if (p.state.mode !== 'away') throw new Error('woke up for another app');
            p.send({ t: 'moveTo', fx: 0.5, fy: 0.5 });
            p.send({ t: 'click', count: 1 });
            p.send({ t: 'key', key: 'Enter' });
            await sleep(500);
            if ((await tv.eval('location.search')) !== '?from=otherapp') throw new Error('phone input reached the other app');
        });

        await step('Show it brings Phone Browser back where it was', async () => {
            tv.injectAgent = true;
            p.send({ t: 'show' });
            await waitFor(() => p.state.mode === 'cdp' && p.state.url.endsWith('test.html?last=1'), 'back on the test page');
            await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');
            p.send({ t: 'exit' });
            await waitFor(() => p.state.mode === 'away', 'away again');
        });
    }

    await step('reopening from TizenBrew starts on a home tab and keeps the last page', async () => {
        const before = p.state.tabs.length;
        await tv.launchPhoneBrowser();
        await waitFor(() => p.state.mode === mode && p.state.home, 'home screen');
        await waitFor(() => p.state.tabs.length === before + 1 && p.state.tabs.some((t) => t.url.endsWith('test.html?last=1')), 'previous tab kept');
        await waitFor(() => tv.eval(`document.body.textContent.includes('return to TizenBrew')`), 'exit hint on home');
    });

    await step('the remote Back key on the home screen returns to TizenBrew', async () => {
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');
        await sleep(300);
        const keyEvent = { windowsVirtualKeyCode: 10009, nativeVirtualKeyCode: 10009, key: 'GoBack', code: 'BrowserBack' };
        await tv.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyEvent });
        await tv.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent });
        await waitFor(async () => (await tv.eval('location.pathname')).includes('/tizenbrew-ui/'), 'TizenBrew menu');
        await tv.launchPhoneBrowser();
        await waitFor(() => p.state.mode === mode && p.state.home, 'reopened');
        await waitFor(() => tv.eval('!!window.__tvr'), 'agent ready');
    });

    await step('bookmarks can be added and removed', async () => {
        p.send({ t: 'bookmarkAdd', url: `${pages}/test.html`, title: 'Test page' });
        await waitFor(() => p.state.bookmarks.some((b) => b.title === 'Test page'), 'bookmark added');
        p.send({ t: 'bookmarkRemove', url: `${pages}/test.html` });
        await waitFor(() => !p.state.bookmarks.some((b) => b.title === 'Test page'), 'bookmark removed');
    });

    await step('home button returns to the TV home screen', async () => {
        p.send({ t: 'home' });
        await waitFor(() => p.state.home === true, 'home');
        await waitFor(() => tv.eval(`!!document.querySelector('.h-qr svg')`), 'home rendered');
    });

    await step('forgetting the phone revokes it', async () => {
        p.send({ t: 'forget' });
        await waitFor(() => p.closedCode, 'socket closed');
        const again = await phone(token);
        await waitFor(() => again.messages.some((m) => m.t === 'auth' && m.ok === false), 'token revoked');
    });
} catch (e) {
    failures++;
    console.log('  FAIL  ' + e.message);
} finally {
    tv.close();
    chrome.kill();
    pageServer.close();
}

console.log(failures ? `${failures} step(s) failed` : 'All steps passed');
process.exit(failures ? 1 : 0);
