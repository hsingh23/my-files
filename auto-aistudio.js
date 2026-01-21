// ==UserScript==
// @name         AI Studio Queue Sender
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Send queued messages with human-like behavior and priority queue
// @author       You
// @match        https://aistudio.google.com/app*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    'use strict';

    let queue = [];
    let priorityQueue = []; // NEW: Priority queue for textarea content
    let currentIndex = 0;
    let isPlaying = false;
    let checkInterval = null;
    let playlists = {};
    let audioContext = null;
    let waitingAfterResponse = false;
    let currentLoadedPlaylist = null;
    let isSending = false;

    let wasRunning = false;
    let runningWatcherInterval = null;

    let lastSendTime = 0;
    let isCooldown = false;
    let cooldownEndTime = null;
    let cooldownInterval = null;
    let toastTimeout = null;

    const STORAGE_KEY = 'aistudio_queue_playlists';
    const STATE_KEY = 'aistudio_queue_state';
    const POST_SEND_DELAY = 4000;

    // ========== ANTI-BOT HELPERS ==========
    function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function simulateMouseMove() {
        try {
            const x = randomBetween(100, window.innerWidth - 100);
            const y = randomBetween(100, window.innerHeight - 100);
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y
            }));
        } catch (e) {}
    }

    function doRandomMoves(count = 3) {
        for (let i = 0; i < count; i++) {
            setTimeout(simulateMouseMove, i * randomBetween(80, 200));
        }
    }

    async function humanType(textarea, text) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;

        textarea.focus();
        doRandomMoves(2);

        nativeSetter.call(textarea, '');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(randomBetween(100, 200));

        const chunkSize = randomBetween(3, 8);
        for (let i = 0; i < text.length; i += chunkSize) {
            const chunk = text.slice(i, Math.min(i + chunkSize, text.length));
            const current = textarea.value;
            nativeSetter.call(textarea, current + chunk);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(randomBetween(30, 80));
            if (Math.random() < 0.1) await sleep(randomBetween(100, 200));
        }

        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        await sleep(randomBetween(150, 300));
        simulateMouseMove();
    }

    // ========== STORAGE ==========
    function storageGet(key, defaultValue) {
        try {
            if (typeof GM_getValue === 'function') {
                const value = GM_getValue(key, null);
                if (value === null || value === undefined) return defaultValue;
                return typeof value === 'string' ? JSON.parse(value) : value;
            }
        } catch (e) {}
        try {
            const value = localStorage.getItem(key);
            return value === null ? defaultValue : JSON.parse(value);
        } catch (e) {}
        return defaultValue;
    }

    function storageSet(key, value) {
        const str = JSON.stringify(value);
        try { if (typeof GM_setValue === 'function') GM_setValue(key, str); } catch (e) {}
        try { localStorage.setItem(key, str); } catch (e) {}
    }

    function loadPlaylists() { playlists = storageGet(STORAGE_KEY, {}); updatePlaylistSelect(); }
    function savePlaylists() { storageSet(STORAGE_KEY, playlists); }

    // ========== STATE PERSISTENCE ==========
    function saveState() {
        const state = {
            playlist: currentLoadedPlaylist,
            index: currentIndex,
            queue: queue,
            priorityQueue: priorityQueue,
            timestamp: Date.now()
        };
        storageSet(STATE_KEY, state);
    }

    function loadState() {
        const state = storageGet(STATE_KEY, null);
        if (!state) return false;

        if (Date.now() - state.timestamp > 24 * 60 * 60 * 1000) return false;

        if (state.playlist) {
            currentLoadedPlaylist = state.playlist;
            if (playlists[state.playlist]) {
                document.getElementById('queue-input').value = playlists[state.playlist];
            }
        }

        if (state.queue && state.queue.length > 0) {
            queue = state.queue;
            priorityQueue = state.priorityQueue || [];
            currentIndex = state.index || 0;
            updateProgress();
            showToast(`Restored: ${currentIndex}/${queue.length}` + (priorityQueue.length ? ` (+${priorityQueue.length} priority)` : ''), 'info');
            return true;
        }
        return false;
    }

    function clearState() {
        storageSet(STATE_KEY, null);
    }

    // ========== STYLES ==========
    GM_addStyle(`
        #queue-sender-ui { position: fixed; top: 100px; right: 20px; width: 340px; background: #1a1a1a; border: 1px solid #333; border-radius: 12px; z-index: 10000; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #fff; box-shadow: 0 8px 32px rgba(0,0,0,0.6); overflow: hidden; }
        #queue-sender-ui .header { display: flex; justify-content: space-between; align-items: center; cursor: move; padding: 12px 15px; background: linear-gradient(135deg, #2d2d2d 0%, #1a1a1a 100%); border-bottom: 1px solid #333; }
        #queue-sender-ui .header h3 { margin: 0; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        #queue-sender-ui .minimize-btn { background: #444; border: none; color: #fff; cursor: pointer; font-size: 14px; width: 24px; height: 24px; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
        #queue-sender-ui .minimize-btn:hover { background: #555; }
        #queue-sender-ui .content { padding: 15px; }
        #queue-sender-ui.minimized .content { display: none; }
        #queue-sender-ui textarea { width: 100%; height: 70px; background: #252525; border: 1px solid #404040; border-radius: 8px; color: #fff; padding: 10px; resize: vertical; box-sizing: border-box; font-size: 12px; font-family: 'Monaco', 'Menlo', monospace; }
        #queue-sender-ui textarea:focus { outline: none; border-color: #4a9eff; }
        #queue-sender-ui input[type="text"] { width: 100%; background: #252525; border: 1px solid #404040; border-radius: 8px; color: #fff; padding: 10px; box-sizing: border-box; font-size: 12px; }
        #queue-sender-ui input[type="number"] { width: 55px; background: #252525; border: 1px solid #404040; border-radius: 6px; color: #fff; padding: 6px 8px; font-size: 12px; text-align: center; }
        #queue-sender-ui select { width: 100%; background: #252525; border: 1px solid #404040; border-radius: 8px; color: #fff; padding: 10px; font-size: 12px; }
        #queue-sender-ui button { background: #404040; border: none; border-radius: 8px; color: #fff; padding: 10px 14px; cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
        #queue-sender-ui button:hover { background: #505050; }
        #queue-sender-ui button.primary { background: linear-gradient(135deg, #4a9eff 0%, #3a7fcf 100%); }
        #queue-sender-ui button.success { background: linear-gradient(135deg, #4aff8a 0%, #2eb86a 100%); color: #000; }
        #queue-sender-ui button.danger { background: linear-gradient(135deg, #ff4a6a 0%, #cf3a5a 100%); }
        #queue-sender-ui button.warning { background: linear-gradient(135deg, #ffaa4a 0%, #cf8a3a 100%); color: #000; }
        #queue-sender-ui button.priority { background: linear-gradient(135deg, #ff4aff 0%, #cf3acf 100%); }
        #queue-sender-ui button:disabled { opacity: 0.5; cursor: not-allowed; }
        #queue-sender-ui .section { margin-bottom: 16px; }
        #queue-sender-ui .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        #queue-sender-ui .section-title { font-size: 11px; font-weight: 600; color: #888; text-transform: uppercase; }
        #queue-sender-ui .section-badge { font-size: 10px; background: #333; padding: 2px 8px; border-radius: 10px; color: #888; }
        #queue-sender-ui .card { background: #222; border: 1px solid #333; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
        #queue-sender-ui .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #333; }
        #queue-sender-ui .card-icon { font-size: 16px; }
        #queue-sender-ui .card-title { font-size: 12px; font-weight: 600; color: #ddd; }
        #queue-sender-ui .btn-row { display: flex; gap: 8px; margin-top: 10px; }
        #queue-sender-ui .btn-row button { flex: 1; }
        #queue-sender-ui .btn-row-3 button { flex: 1; padding: 10px 8px; }
        #queue-sender-ui .loaded-indicator { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: linear-gradient(135deg, #1a3a2a 0%, #1a2a1a 100%); border: 1px solid #2a5a3a; border-radius: 8px; margin-bottom: 10px; font-size: 11px; color: #6aff9a; }
        #queue-sender-ui .loaded-indicator.empty { background: #252525; border-color: #333; color: #666; }
        #queue-sender-ui .checkbox-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
        #queue-sender-ui .checkbox-row input { width: 16px; height: 16px; margin: 0; }
        #queue-sender-ui .checkbox-row label { font-size: 12px; color: #bbb; cursor: pointer; flex: 1; }
        #queue-sender-ui .settings-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 11px; color: #888; }
        #queue-sender-ui .progress-section { background: #222; border: 1px solid #333; border-radius: 10px; padding: 12px; }
        #queue-sender-ui .progress-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
        #queue-sender-ui .progress-label { font-size: 11px; color: #888; }
        #queue-sender-ui .progress-value { font-size: 12px; font-weight: 600; }
        #queue-sender-ui .progress-bar { width: 100%; height: 8px; background: #333; border-radius: 4px; overflow: hidden; }
        #queue-sender-ui .progress-fill { height: 100%; background: linear-gradient(90deg, #4a9eff, #4aff8a); transition: width 0.3s; width: 0%; }
        #queue-sender-ui .status-bar { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 10px; background: #1a1a1a; border-radius: 6px; font-size: 11px; }
        #queue-sender-ui .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
        #queue-sender-ui .status-dot.running { background: #4aff8a; animation: pulse 1s infinite; }
        #queue-sender-ui .status-dot.cooldown { background: #ffaa4a; animation: pulse 1s infinite; }
        #queue-sender-ui .status-dot.priority { background: #ff4aff; animation: pulse 1s infinite; }
        #queue-sender-ui .status-text { color: #888; flex: 1; }
        #queue-sender-ui .status-text.running { color: #4aff8a; }
        #queue-sender-ui .status-text.cooldown { color: #ffaa4a; }
        #queue-sender-ui .status-text.priority { color: #ff4aff; }
        #queue-sender-ui .cooldown-timer { margin-top: 10px; padding: 12px; background: linear-gradient(135deg, #3d2d1d 0%, #2d1d0d 100%); border: 1px solid #5a4a2a; border-radius: 8px; text-align: center; display: none; }
        #queue-sender-ui .cooldown-timer.active { display: block; }
        #queue-sender-ui .cooldown-timer .time { font-size: 24px; font-weight: 700; color: #ffaa4a; }
        #queue-sender-ui .cooldown-timer .label { font-size: 10px; color: #aa8a4a; text-transform: uppercase; margin-top: 4px; }
        #queue-sender-ui .priority-indicator { margin-top: 10px; padding: 10px; background: linear-gradient(135deg, #3d1d3d 0%, #2d0d2d 100%); border: 1px solid #5a2a5a; border-radius: 8px; display: none; }
        #queue-sender-ui .priority-indicator.active { display: block; }
        #queue-sender-ui .priority-indicator .count { font-size: 18px; font-weight: 700; color: #ff4aff; }
        #queue-sender-ui .priority-indicator .label { font-size: 10px; color: #aa4aaa; text-transform: uppercase; }
        #queue-sender-ui .priority-indicator .items { margin-top: 8px; font-size: 10px; color: #cc6acc; max-height: 60px; overflow-y: auto; }
        #queue-sender-ui .priority-indicator .items div { padding: 2px 0; border-bottom: 1px solid #3a1a3a; }
        #queue-sender-ui .queue-preview { margin-top: 10px; max-height: 80px; overflow-y: auto; background: #1a1a1a; border-radius: 6px; padding: 8px; }
        #queue-sender-ui .queue-item { padding: 4px 8px; font-size: 11px; color: #666; border-radius: 4px; margin-bottom: 2px; }
        #queue-sender-ui .queue-item.current { background: rgba(74, 158, 255, 0.2); color: #4a9eff; }
        #queue-sender-ui .queue-item.done { text-decoration: line-through; color: #444; }
        #queue-sender-ui .queue-item.priority { background: rgba(255, 74, 255, 0.2); color: #ff4aff; }
        #queue-sender-ui .running-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #444; }
        #queue-sender-ui .running-indicator.active { background: #4aff8a; animation: pulse 1s infinite; }
        #queue-sender-ui .toast { position: absolute; top: 60px; left: 15px; right: 15px; padding: 10px 14px; border-radius: 8px; font-size: 12px; font-weight: 500; display: none; align-items: center; gap: 8px; z-index: 10; }
        #queue-sender-ui .toast.show { display: flex; }
        #queue-sender-ui .toast.success { background: linear-gradient(135deg, #1a3a2a 0%, #1a2a1a 100%); border: 1px solid #2a5a3a; color: #4aff8a; }
        #queue-sender-ui .toast.error { background: linear-gradient(135deg, #3a1a2a 0%, #2a1a1a 100%); border: 1px solid #5a2a3a; color: #ff4a6a; }
        #queue-sender-ui .toast.info { background: linear-gradient(135deg, #1a2a3a 0%, #1a1a2a 100%); border: 1px solid #2a3a5a; color: #4a9eff; }
        #queue-sender-ui .playlist-preview { margin-top: 8px; padding: 8px; background: #1a1a1a; border-radius: 6px; font-size: 10px; color: #666; max-height: 40px; overflow: hidden; font-family: monospace; }
        #queue-sender-ui .divider { height: 1px; background: #333; margin: 12px 0; }
        #queue-sender-ui .help-text { font-size: 10px; color: #555; margin-top: 6px; }
        #queue-sender-ui .textarea-preview { margin-top: 8px; padding: 8px; background: #1a2a1a; border: 1px solid #2a4a3a; border-radius: 6px; font-size: 10px; color: #6a9a6a; max-height: 40px; overflow: hidden; font-family: monospace; }
        #queue-sender-ui .textarea-preview.empty { background: #252525; border-color: #333; color: #555; }
        #queue-sender-ui .textarea-preview.has-priority { background: #2a1a2a; border-color: #4a2a4a; color: #aa6aaa; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    `);

    // ========== DOM HELPER ==========
    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'className') e.className = v;
            else if (k === 'textContent') e.textContent = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v);
        });
        children.forEach(c => {
            if (typeof c === 'string') e.appendChild(document.createTextNode(c));
            else if (c) e.appendChild(c);
        });
        return e;
    }

    function clearEl(elem) {
        while (elem.firstChild) elem.removeChild(elem.firstChild);
    }

    // ========== UTILS ==========
    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.getElementById('toast-notification');
        if (!toast) return;
        if (toastTimeout) clearTimeout(toastTimeout);
        clearEl(toast);
        toast.className = 'toast show ' + type;
        const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
        toast.appendChild(document.createTextNode(icon + ' ' + message));
        toastTimeout = setTimeout(() => toast.classList.remove('show'), duration);
    }

    function initAudio() {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        return audioContext;
    }

    function playDing() {
        const elem = document.getElementById('sound-enabled');
        if (elem && !elem.checked) return;
        forcePlayDing();
    }

    function forcePlayDing() {
        try {
            const ctx = initAudio();
            if (ctx.state === 'suspended') ctx.resume();
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.1);
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
        } catch (e) {}
    }

    function clickSaveButton() {
        const btn = document.querySelector('ms-console-component .save-app-button');
        if (btn) { btn.click(); return true; }
        return false;
    }

    function isModelRunning() {
        return !!document.querySelector('ms-code-assistant-chat .running');
    }

    function startRunningWatcher() {
        if (runningWatcherInterval) clearInterval(runningWatcherInterval);
        wasRunning = isModelRunning();
        runningWatcherInterval = setInterval(() => {
            const running = isModelRunning();
            const ind = document.getElementById('running-indicator');
            const dot = document.getElementById('status-dot');
            if (ind) ind.classList.toggle('active', running);
            if (dot && !isCooldown && priorityQueue.length === 0) dot.classList.toggle('running', running);
            if (wasRunning && !running) playDing();
            wasRunning = running;

            updateTextareaPreview();
            updatePriorityIndicator();
        }, 500);
    }

    function formatTime(s) {
        return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
    }

    function updateLoadedIndicator() {
        const ind = document.getElementById('loaded-playlist-indicator');
        if (!ind) return;
        clearEl(ind);
        const icon = el('span', { className: 'icon', textContent: currentLoadedPlaylist ? '📋' : '📭' });
        const text = el('span', { textContent: currentLoadedPlaylist ? 'Loaded: ' + currentLoadedPlaylist : 'No playlist loaded' });
        ind.appendChild(icon);
        ind.appendChild(text);
        ind.classList.toggle('empty', !currentLoadedPlaylist);
    }

    function updatePlaylistPreview() {
        const sel = document.getElementById('playlist-select');
        const prev = document.getElementById('playlist-preview');
        if (!sel || !prev) return;
        const name = sel.value;
        clearEl(prev);
        if (name && playlists[name]) {
            const content = playlists[name];
            prev.textContent = content.substring(0, 100) + (content.length > 100 ? '...' : '');
            prev.style.display = 'block';
        } else {
            prev.style.display = 'none';
        }
    }

    // ========== TEXTAREA DETECTION ==========
    function getAIStudioTextarea() {
        return document.querySelector('ms-code-assistant-chat textarea');
    }

    function getExistingTextareaContent() {
        const textarea = getAIStudioTextarea();
        if (!textarea) return '';
        return textarea.value.trim();
    }

    function updateTextareaPreview() {
        const preview = document.getElementById('textarea-content-preview');
        if (!preview) return;

        const prependEnabled = document.getElementById('prepend-enabled');
        if (!prependEnabled || !prependEnabled.checked) {
            preview.style.display = 'none';
            return;
        }

        const content = getExistingTextareaContent();
        clearEl(preview);

        if (content) {
            const items = parseQueue(content);
            preview.textContent = `⚡ Priority queue: ${items.length} item(s) - "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`;
            preview.className = 'textarea-preview has-priority';
            preview.style.display = 'block';
        } else {
            preview.textContent = '📝 No priority items (AI Studio textarea empty)';
            preview.className = 'textarea-preview empty';
            preview.style.display = 'block';
        }
    }

    // ========== PRIORITY QUEUE INDICATOR ==========
    function updatePriorityIndicator() {
        const ind = document.getElementById('priority-indicator');
        if (!ind) return;

        if (priorityQueue.length > 0) {
            ind.classList.add('active');
            const countEl = ind.querySelector('.count');
            const itemsEl = ind.querySelector('.items');
            if (countEl) countEl.textContent = priorityQueue.length;
            if (itemsEl) {
                clearEl(itemsEl);
                priorityQueue.slice(0, 5).forEach((item, i) => {
                    const div = el('div', { textContent: `${i + 1}. ${item.substring(0, 40)}${item.length > 40 ? '...' : ''}` });
                    itemsEl.appendChild(div);
                });
                if (priorityQueue.length > 5) {
                    itemsEl.appendChild(el('div', { textContent: `... and ${priorityQueue.length - 5} more` }));
                }
            }
        } else {
            ind.classList.remove('active');
        }
    }

    // ========== COOLDOWN ==========
    function startCooldown() {
        const secs = parseInt(document.getElementById('cooldown-time').value) || 60;
        isCooldown = true;
        cooldownEndTime = Date.now() + secs * 1000;
        document.getElementById('cooldown-timer').classList.add('active');
        const dot = document.getElementById('status-dot');
        if (dot) { dot.classList.remove('running', 'priority'); dot.classList.add('cooldown'); }
        updateCooldownDisplay();
        cooldownInterval = setInterval(() => {
            if (Math.ceil((cooldownEndTime - Date.now()) / 1000) <= 0) endCooldown();
            else updateCooldownDisplay();
        }, 1000);
    }

    function updateCooldownDisplay() {
        const rem = Math.max(0, Math.ceil((cooldownEndTime - Date.now()) / 1000));
        const t = document.getElementById('cooldown-time-display');
        if (t) t.textContent = formatTime(rem);
        updateStatus('Rate limit cooldown...', 'cooldown');
    }

    function endCooldown() {
        isCooldown = false;
        if (cooldownInterval) { clearInterval(cooldownInterval); cooldownInterval = null; }
        document.getElementById('cooldown-timer').classList.remove('active');
        const dot = document.getElementById('status-dot');
        if (dot) dot.classList.remove('cooldown');
        forcePlayDing();
        showToast('Cooldown ended', 'success');
    }

    function shouldTriggerCooldown() {
        if (!lastSendTime) return false;
        const threshold = (parseInt(document.getElementById('min-response-time').value) || 10) * 1000;
        return Date.now() - lastSendTime < threshold;
    }

    // ========== CHECK FOR NEW PRIORITY ITEMS ==========
    function checkAndLoadPriorityItems() {
        const prependEnabled = document.getElementById('prepend-enabled');
        if (!prependEnabled || !prependEnabled.checked) return false;

        const content = getExistingTextareaContent();
        if (!content) return false;

        const newItems = parseQueue(content);
        if (newItems.length === 0) return false;

        // Add to priority queue
        priorityQueue.push(...newItems);
        console.log('[Queue Sender] Added to priority queue:', newItems);
        console.log('[Queue Sender] Priority queue now:', priorityQueue);

        // Clear the AI Studio textarea since we've captured its content
        const textarea = getAIStudioTextarea();
        if (textarea) {
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(textarea, '');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        showToast(`+${newItems.length} priority item(s) added`, 'success');
        updatePriorityIndicator();
        saveState();

        return true;
    }

    // ========== UI ==========
    function createUI() {
        const container = el('div', { id: 'queue-sender-ui' });
        container.appendChild(el('div', { className: 'toast', id: 'toast-notification' }));

        // Header
        const header = el('div', { className: 'header' });
        const title = el('h3', {}, [
            '📨 Queue Sender ',
            el('span', { className: 'running-indicator', id: 'running-indicator' })
        ]);
        const minBtn = el('button', { className: 'minimize-btn', textContent: '−', onClick: () => {
            container.classList.toggle('minimized');
            minBtn.textContent = container.classList.contains('minimized') ? '+' : '−';
        }});
        header.appendChild(title);
        header.appendChild(minBtn);
        container.appendChild(header);

        const content = el('div', { className: 'content' });

        // Messages
        const msgSec = el('div', { className: 'section' });
        msgSec.appendChild(el('div', { className: 'section-header' }, [
            el('span', { className: 'section-title', textContent: '💬 Messages' })
        ]));
        msgSec.appendChild(el('textarea', { id: 'queue-input', placeholder: 'Messages separated by ~' }));
        msgSec.appendChild(el('div', { className: 'help-text', textContent: 'Separate with ~ symbol. Use AI Studio textarea for priority items.' }));
        msgSec.appendChild(el('div', { className: 'textarea-preview empty', id: 'textarea-content-preview', style: 'display:none' }));
        content.appendChild(msgSec);

        // Controls
        const ctrlCard = el('div', { className: 'card' });
        ctrlCard.appendChild(el('div', { className: 'card-header' }, [
            el('span', { className: 'card-icon', textContent: '▶️' }),
            el('span', { className: 'card-title', textContent: 'Controls' })
        ]));
        ctrlCard.appendChild(el('div', { className: 'btn-row btn-row-3' }, [
            el('button', { className: 'primary', textContent: '▶ Play', onClick: startQueue }),
            el('button', { className: 'danger', textContent: '■ Stop', onClick: stopQueue }),
            el('button', { className: 'warning', textContent: '↺ Reset', onClick: resetProgress })
        ]));
        ctrlCard.appendChild(el('div', { className: 'btn-row', style: 'margin-top:8px' }, [
            el('button', { textContent: '⏭ Skip', style: 'flex:1', onClick: skipCurrent }),
            el('button', { className: 'priority', textContent: '⚡ Grab Priority', onClick: manualGrabPriority }),
            el('button', { textContent: '🔔', onClick: forcePlayDing })
        ]));
        content.appendChild(ctrlCard);

        // Playlists
        const plCard = el('div', { className: 'card' });
        plCard.appendChild(el('div', { className: 'card-header' }, [
            el('span', { className: 'card-icon', textContent: '📁' }),
            el('span', { className: 'card-title', textContent: 'Playlists' }),
            el('span', { className: 'section-badge', id: 'playlist-count', textContent: '0' })
        ]));
        plCard.appendChild(el('div', { className: 'loaded-indicator empty', id: 'loaded-playlist-indicator' }));
        const sel = el('select', { id: 'playlist-select', onChange: updatePlaylistPreview });
        sel.appendChild(el('option', { value: '', textContent: '— Select —' }));
        plCard.appendChild(sel);
        plCard.appendChild(el('div', { className: 'playlist-preview', id: 'playlist-preview', style: 'display:none' }));
        plCard.appendChild(el('div', { className: 'btn-row' }, [
            el('button', { className: 'primary', textContent: '📂 Load', onClick: loadPlaylist }),
            el('button', { className: 'danger', textContent: '🗑️', onClick: deletePlaylist })
        ]));
        plCard.appendChild(el('div', { className: 'divider' }));
        plCard.appendChild(el('input', { type: 'text', id: 'playlist-name', placeholder: 'Playlist name...' }));
        plCard.appendChild(el('div', { className: 'btn-row', style: 'margin-top:8px' }, [
            el('button', { className: 'success', textContent: '💾 Save', style: 'flex:1', onClick: savePlaylist })
        ]));
        content.appendChild(plCard);

        // Options
        const optCard = el('div', { className: 'card' });
        optCard.appendChild(el('div', { className: 'card-header' }, [
            el('span', { className: 'card-icon', textContent: '⚙️' }),
            el('span', { className: 'card-title', textContent: 'Options' })
        ]));
        const soundRow = el('div', { className: 'checkbox-row' });
        const soundCb = el('input', { type: 'checkbox', id: 'sound-enabled' });
        soundCb.checked = true;
        soundRow.appendChild(soundCb);
        soundRow.appendChild(el('label', { for: 'sound-enabled', textContent: '🔔 Sound notifications' }));
        optCard.appendChild(soundRow);

        const saveRow = el('div', { className: 'checkbox-row' });
        const saveCb = el('input', { type: 'checkbox', id: 'autosave-enabled' });
        saveCb.checked = true;
        saveRow.appendChild(saveCb);
        saveRow.appendChild(el('label', { for: 'autosave-enabled', textContent: '💾 Auto-save after each response' }));
        optCard.appendChild(saveRow);

        const prependRow = el('div', { className: 'checkbox-row' });
        const prependCb = el('input', { type: 'checkbox', id: 'prepend-enabled', onChange: updateTextareaPreview });
        prependCb.checked = true;
        prependRow.appendChild(prependCb);
        prependRow.appendChild(el('label', { for: 'prepend-enabled', textContent: '⚡ Enable priority queue (from AI Studio textarea)' }));
        optCard.appendChild(prependRow);

        const rateRow = el('div', { className: 'settings-row' }, [
            '⚡ If response <',
            el('input', { type: 'number', id: 'min-response-time', value: '10', min: '1', max: '300' }),
            's, wait ',
            el('input', { type: 'number', id: 'cooldown-time', value: '60', min: '10', max: '600' }),
            's'
        ]);
        optCard.appendChild(rateRow);
        content.appendChild(optCard);

        // Progress
        const progSec = el('div', { className: 'progress-section' });
        progSec.appendChild(el('div', { className: 'progress-header' }, [
            el('span', { className: 'progress-label', textContent: 'Progress' }),
            el('span', { className: 'progress-value' }, [
                el('span', { id: 'progress-current', textContent: '0' }),
                '/',
                el('span', { id: 'progress-total', textContent: '0' })
            ])
        ]));
        progSec.appendChild(el('div', { className: 'progress-bar' }, [
            el('div', { className: 'progress-fill', id: 'progress-fill' })
        ]));
        progSec.appendChild(el('div', { className: 'status-bar' }, [
            el('div', { className: 'status-dot', id: 'status-dot' }),
            el('div', { className: 'status-text', id: 'status-text', textContent: 'Ready' })
        ]));
        progSec.appendChild(el('div', { className: 'cooldown-timer', id: 'cooldown-timer' }, [
            el('div', { className: 'time', id: 'cooldown-time-display', textContent: '0:00' }),
            el('div', { className: 'label', textContent: 'Cooldown' })
        ]));

        // Priority indicator
        const priorityInd = el('div', { className: 'priority-indicator', id: 'priority-indicator' }, [
            el('div', { className: 'count', textContent: '0' }),
            el('div', { className: 'label', textContent: 'Priority Items' }),
            el('div', { className: 'items' })
        ]);
        progSec.appendChild(priorityInd);

        progSec.appendChild(el('div', { className: 'queue-preview', id: 'queue-preview' }));
        content.appendChild(progSec);

        container.appendChild(content);
        document.body.appendChild(container);
        makeDraggable(container, header);
        loadPlaylists();
        updateLoadedIndicator();
        startRunningWatcher();

        setTimeout(() => {
            loadState();
            updateLoadedIndicator();
            updateTextareaPreview();
            updatePriorityIndicator();
        }, 100);
    }

    function makeDraggable(elem, handle) {
        let drag = false, ox, oy;
        handle.addEventListener('mousedown', e => {
            if (e.target.classList.contains('minimize-btn')) return;
            drag = true;
            ox = e.clientX - elem.offsetLeft;
            oy = e.clientY - elem.offsetTop;
        });
        document.addEventListener('mousemove', e => {
            if (drag) {
                elem.style.left = (e.clientX - ox) + 'px';
                elem.style.top = (e.clientY - oy) + 'px';
                elem.style.right = 'auto';
            }
        });
        document.addEventListener('mouseup', () => { drag = false; });
    }

    function parseQueue(input) {
        return input.split('~').map(s => s.trim()).filter(s => s);
    }

    function updateProgress() {
        const pct = queue.length ? (currentIndex / queue.length) * 100 : 0;
        document.getElementById('progress-current').textContent = currentIndex;
        document.getElementById('progress-total').textContent = queue.length;
        document.getElementById('progress-fill').style.width = pct + '%';

        const prev = document.getElementById('queue-preview');
        clearEl(prev);

        // Show priority items first
        priorityQueue.forEach((m, i) => {
            const item = el('div', { className: 'queue-item priority' });
            item.textContent = `⚡ ${i + 1}. ${m.substring(0, 35)}${m.length > 35 ? '...' : ''}`;
            prev.appendChild(item);
        });

        // Show regular queue items
        queue.forEach((m, i) => {
            const item = el('div', { className: 'queue-item' });
            if (i < currentIndex) item.classList.add('done');
            if (i === currentIndex && isPlaying && priorityQueue.length === 0) item.classList.add('current');
            item.textContent = (i + 1) + '. ' + m.substring(0, 40) + (m.length > 40 ? '...' : '');
            prev.appendChild(item);
        });

        saveState();
    }

    function updateStatus(text, state = '') {
        const statusEl = document.getElementById('status-text');
        const dot = document.getElementById('status-dot');
        statusEl.textContent = text;
        statusEl.className = 'status-text' + (state ? ' ' + state : '');
        if (dot) {
            dot.classList.remove('running', 'cooldown', 'priority');
            if (state) dot.classList.add(state);
        }
    }

    function manualGrabPriority() {
        if (checkAndLoadPriorityItems()) {
            updateProgress();
        } else {
            showToast('No priority items found in textarea', 'info');
        }
    }

    // ========== SEND MESSAGE LOGIC ==========
    async function sendMessage(text) {
        const textarea = getAIStudioTextarea();
        if (!textarea) {
            showToast('Textarea not found!', 'error');
            return false;
        }

        isSending = true;
        doRandomMoves(2);
        await sleep(randomBetween(200, 500));

        await humanType(textarea, text);
        lastSendTime = Date.now();

        await sleep(randomBetween(300, 600));
        simulateMouseMove();

        let sendBtn = document.querySelector('[aria-label="Send"]');
        if (sendBtn && sendBtn.tagName !== 'BUTTON' && sendBtn.closest('button')) {
            sendBtn = sendBtn.closest('button');
        }
        if (!sendBtn) {
            sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                      document.querySelector('button[aria-label*="Run"]') ||
                      document.querySelector('ms-code-assistant-chat button.mat-mdc-icon-button');
        }

        if (sendBtn) {
            const rect = sendBtn.getBoundingClientRect();
            const opts = {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2
            };
            sendBtn.dispatchEvent(new MouseEvent('mousedown', opts));
            sendBtn.dispatchEvent(new MouseEvent('mouseup', opts));
            sendBtn.click();
        } else {
            textarea.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, shiftKey: false
            }));
            textarea.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true, shiftKey: false
            }));
        }

        await sleep(POST_SEND_DELAY);
        isSending = false;
        return true;
    }

    function processQueue() {
        if (!isPlaying || isCooldown || isSending) return;

        // Check for new priority items before each send
        checkAndLoadPriorityItems();

        // Check if we're completely done
        if (priorityQueue.length === 0 && currentIndex >= queue.length) {
            stopQueue();
            updateStatus('✓ Done!', '');
            showToast('Queue completed!', 'success');
            clearState();
            if (document.getElementById('autosave-enabled').checked) clickSaveButton();
            return;
        }

        if (isModelRunning()) {
            const statusMsg = priorityQueue.length > 0
                ? `Waiting... (${priorityQueue.length} priority pending)`
                : 'Waiting...';
            updateStatus(statusMsg, priorityQueue.length > 0 ? 'priority' : 'running');
            waitingAfterResponse = true;
            return;
        }

        if (waitingAfterResponse) {
            waitingAfterResponse = false;
            const autoSave = document.getElementById('autosave-enabled').checked;
            if (autoSave) clickSaveButton();

            if (shouldTriggerCooldown()) {
                showToast('Too fast, cooling down...', 'info');
                startCooldown();
                return;
            }

            if (autoSave) {
                updateStatus('Saving...', 'running');
                setTimeout(() => {
                    if (isPlaying && !isCooldown && !isSending) sendNext();
                }, 1500);
                return;
            }
        }

        sendNext();
    }

    async function sendNext() {
        if (!isPlaying || isCooldown || isSending) return;

        // Priority queue takes precedence
        if (priorityQueue.length > 0) {
            const priorityItem = priorityQueue.shift();
            updateStatus(`⚡ Priority ${priorityQueue.length + 1} remaining...`, 'priority');
            console.log('[Queue Sender] Sending priority item:', priorityItem.substring(0, 50));

            if (await sendMessage(priorityItem)) {
                updateProgress();
                updatePriorityIndicator();
                waitingAfterResponse = true;
            }
            return;
        }

        // Regular queue
        if (currentIndex >= queue.length) return;

        updateStatus('Sending ' + (currentIndex + 1) + '/' + queue.length + '...', 'running');
        if (await sendMessage(queue[currentIndex])) {
            currentIndex++;
            updateProgress();
            waitingAfterResponse = true;
        }
    }

    function startQueue() {
        let newQueue = parseQueue(document.getElementById('queue-input').value);

        if (!newQueue.length && priorityQueue.length === 0) {
            // Check if there's anything in the textarea to use as priority
            checkAndLoadPriorityItems();

            if (priorityQueue.length === 0) {
                showToast('No messages in queue!', 'error');
                return;
            }
        }

        if (newQueue.length > 0) {
            queue = newQueue;
            currentIndex = 0;
        }

        // Also check for initial priority items
        checkAndLoadPriorityItems();

        initAudio();
        isPlaying = true;
        waitingAfterResponse = false;
        lastSendTime = 0;
        isCooldown = false;
        isSending = false;
        updateProgress();
        updatePriorityIndicator();

        const totalItems = queue.length + priorityQueue.length;
        updateStatus('Starting...', priorityQueue.length > 0 ? 'priority' : 'running');
        showToast(`${totalItems} messages queued` + (priorityQueue.length > 0 ? ` (${priorityQueue.length} priority)` : ''), 'info');

        if (checkInterval) clearInterval(checkInterval);
        checkInterval = setInterval(processQueue, 1000);
        processQueue();
    }

    function stopQueue() {
        isPlaying = false;
        isSending = false;
        waitingAfterResponse = false;
        if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
        if (cooldownInterval) { clearInterval(cooldownInterval); cooldownInterval = null; }
        isCooldown = false;
        const timer = document.getElementById('cooldown-timer');
        if (timer) timer.classList.remove('active');
        updateStatus('Stopped', '');
        saveState();
    }

    function resetProgress() {
        if (isPlaying) {
            showToast('Stop queue first!', 'error');
            return;
        }
        currentIndex = 0;
        priorityQueue = [];
        queue = parseQueue(document.getElementById('queue-input').value);
        updateProgress();
        updatePriorityIndicator();
        clearState();
        showToast('Progress reset', 'success');
        updateStatus('Ready', '');
    }

    function skipCurrent() {
        if (!isPlaying) {
            showToast('Queue not running', 'error');
            return;
        }

        // Skip priority item first if any
        if (priorityQueue.length > 0) {
            const skipped = priorityQueue.shift();
            showToast(`Skipped priority: ${skipped.substring(0, 30)}...`, 'info');
            updateProgress();
            updatePriorityIndicator();
            waitingAfterResponse = false;
            return;
        }

        if (currentIndex < queue.length) {
            showToast(`Skipped: ${queue[currentIndex].substring(0, 30)}...`, 'info');
            currentIndex++;
            updateProgress();
            waitingAfterResponse = false;
        }
    }

    function savePlaylist() {
        const name = document.getElementById('playlist-name').value.trim();
        const content = document.getElementById('queue-input').value;
        if (!name) { showToast('Enter name', 'error'); return; }
        if (!content.trim()) { showToast('No messages', 'error'); return; }
        playlists[name] = content;
        savePlaylists();
        updatePlaylistSelect();
        document.getElementById('playlist-name').value = '';
        currentLoadedPlaylist = name;
        updateLoadedIndicator();
        saveState();
        showToast('Saved "' + name + '"', 'success');
    }

    function loadPlaylist() {
        const name = document.getElementById('playlist-select').value;
        if (!name || !playlists[name]) { showToast('Select playlist', 'error'); return; }
        document.getElementById('queue-input').value = playlists[name];
        currentLoadedPlaylist = name;
        updateLoadedIndicator();

        currentIndex = 0;
        queue = parseQueue(playlists[name]);
        updateProgress();
        saveState();

        showToast('Loaded "' + name + '"', 'success');
    }

    function deletePlaylist() {
        const name = document.getElementById('playlist-select').value;
        if (!name) { showToast('Select playlist', 'error'); return; }
        if (confirm('Delete "' + name + '"?')) {
            delete playlists[name];
            savePlaylists();
            updatePlaylistSelect();
            updatePlaylistPreview();
            if (currentLoadedPlaylist === name) {
                currentLoadedPlaylist = null;
                updateLoadedIndicator();
            }
            showToast('Deleted', 'success');
        }
    }

    function updatePlaylistSelect() {
        const sel = document.getElementById('playlist-select');
        if (!sel) return;
        const cur = sel.value;
        clearEl(sel);
        sel.appendChild(el('option', { value: '', textContent: '— Select —' }));
        const names = Object.keys(playlists).sort();
        names.forEach(n => {
            const cnt = parseQueue(playlists[n]).length;
            sel.appendChild(el('option', { value: n, textContent: n + ' (' + cnt + ')' }));
        });
        if (names.includes(cur)) sel.value = cur;
        const badge = document.getElementById('playlist-count');
        if (badge) badge.textContent = names.length;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(createUI, 1000));
    } else {
        setTimeout(createUI, 1000);
    }
})();