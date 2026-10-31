'use strict';

// Paired phones, bookmarks, open tabs and settings, persisted next to
// TizenBrew's own config.

const fs = require('fs');
const log = require('./log');

const DEFAULT_BOOKMARKS = [
    { title: 'Google', url: 'https://www.google.com/' },
    { title: 'YouTube', url: 'https://www.youtube.com/' },
    { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
    { title: 'DuckDuckGo', url: 'https://duckduckgo.com/' }
];

class Store {
    constructor(file) {
        this.file = file;
        this.data = { tokens: [], bookmarks: DEFAULT_BOOKMARKS.slice(), tabs: [], settings: { blockPopups: false } };
        this._saveTimer = null;
        try {
            const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(loaded.tokens)) this.data.tokens = loaded.tokens;
            if (Array.isArray(loaded.bookmarks)) this.data.bookmarks = loaded.bookmarks;
            if (Array.isArray(loaded.tabs)) this.data.tabs = loaded.tabs;
            if (loaded.settings && typeof loaded.settings === 'object') {
                Object.keys(loaded.settings).forEach((k) => { this.data.settings[k] = loaded.settings[k]; });
            }
        } catch (e) {
            if (e.code !== 'ENOENT') log.warn('Could not read', file, e.message);
        }
    }

    save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            fs.writeFile(this.file, JSON.stringify(this.data, null, 2), (err) => {
                if (err) log.warn('Could not save settings:', err.message);
            });
        }, 200);
    }

    hasToken(token) {
        return !!token && this.data.tokens.some((t) => t.token === token);
    }

    addToken(token, name) {
        this.data.tokens.push({ token: token, name: name || 'Phone', created: Date.now() });
        this.save();
    }

    removeToken(token) {
        this.data.tokens = this.data.tokens.filter((t) => t.token !== token);
        this.save();
    }

    clearTokens() {
        this.data.tokens = [];
        this.save();
    }

    bookmarks() {
        return this.data.bookmarks.slice();
    }

    addBookmark(title, url) {
        if (!/^https?:\/\//i.test(url)) return;
        this.data.bookmarks = this.data.bookmarks.filter((b) => b.url !== url);
        this.data.bookmarks.unshift({ title: String(title || url).substr(0, 120), url: url });
        this.data.bookmarks = this.data.bookmarks.slice(0, 48);
        this.save();
    }

    removeBookmark(url) {
        this.data.bookmarks = this.data.bookmarks.filter((b) => b.url !== url);
        this.save();
    }

    tabs() {
        return this.data.tabs.slice();
    }

    setTabs(list) {
        this.data.tabs = list;
        this.save();
    }

    setting(key) {
        return this.data.settings[key];
    }

    setSetting(key, value) {
        this.data.settings[key] = value;
        this.save();
    }
}

module.exports = Store;
