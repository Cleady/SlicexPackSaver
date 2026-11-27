/**
 * background.js
 * MV3 Service Worker: manages tabCapture stream IDs, offscreen document lifecycle,
 * organized WAV downloads, keepalive port, settings, and live session state.
 */

'use strict';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const STORAGE_KEYS = {
  STATE: 'sessionState',
  SETTINGS: 'recorderSettings',
  PROCESSED_BY_URL: 'processedItemsByUrl'
};

const DEFAULT_SETTINGS = {
  silentMode: false,
  autoTrimLeading: true,
  skipExistingFiles: true,
  tailBufferMs: 150,
  intervalDelayMs: 500,
  selectors: {
    collectionTitleSelector: 'h1',
    rowSelector: '[data-testid*="sample"], [role="row"], tr',
    itemNameSelector: '[data-testid*="filename"], .filename, a, span',
    playButtonSelector: 'button[aria-label*="Play" i], button[aria-label*="Pause" i], button',
    paginationSelector: 'button[aria-label*="next" i], a[aria-label*="next" i], [class*="pagination"] button'
  }
};

const DEFAULT_STATE = {
  status: 'idle', // 'idle' | 'running' | 'paused' | 'completed' | 'error'
  tabId: null,
  tabUrl: '',
  folderName: '',
  currentFile: '',
  processedCount: 0,
  totalCount: 0,
  skippedCount: 0,
  errorMessage: '',
  startedAt: null,
  logs: []
};

const MAX_LOG_ENTRIES = 120;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// In-memory runtime tracking
let sessionState = structuredClone(DEFAULT_STATE);
let recorderSettings = structuredClone(DEFAULT_SETTINGS);
let initialized = false;
let creatingOffscreenPromise = null;
let pendingCloseOffscreenAfterDownloads = false;
let closeOffscreenFallbackTimer = null;

// downloadId -> blobUrl
const pendingDownloads = new Map();

/**
 * Hydrates state and settings from chrome.storage.local on service worker startup.
 */
async function ensureInitialized() {
  if (initialized) return;
  const stored = await chrome.storage.local.get([STORAGE_KEYS.STATE, STORAGE_KEYS.SETTINGS]);

  if (stored[STORAGE_KEYS.SETTINGS]) {
    recorderSettings = mergeSettings(DEFAULT_SETTINGS, stored[STORAGE_KEYS.SETTINGS]);
  }
  if (stored[STORAGE_KEYS.STATE]) {
    sessionState = { ...structuredClone(DEFAULT_STATE), ...stored[STORAGE_KEYS.STATE] };
  }

  // If service worker restarted while state claimed running, verify offscreen is still alive
  if (sessionState.status === 'running' || sessionState.status === 'paused') {
    const hasOffscreen = await hasOffscreenDocument();
    if (!hasOffscreen) {
      sessionState.status = 'idle';
      sessionState.currentFile = '';
      await persistState();
    }
  }

  initialized = true;
}

function mergeSettings(base, override) {
  const merged = {
    ...base,
    ...override,
    selectors: {
      ...base.selectors,
      ...(override?.selectors || {})
    }
  };
  merged.tailBufferMs = clampInt(merged.tailBufferMs, 0, 5000, DEFAULT_SETTINGS.tailBufferMs);
  merged.intervalDelayMs = clampInt(merged.intervalDelayMs, 50, 10000, DEFAULT_SETTINGS.intervalDelayMs);
  merged.silentMode = Boolean(merged.silentMode);
  merged.autoTrimLeading = Boolean(merged.autoTrimLeading);
  merged.skipExistingFiles = merged.skipExistingFiles !== false;
  return merged;
}

function clampInt(val, min, max, fallback) {
  const n = Number.parseInt(val, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeSegment(raw, fallback = 'Untitled') {
  if (!raw || typeof raw !== 'string') return fallback;
  let cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '');
  if (!cleaned) return fallback;
  if (WINDOWS_RESERVED_RE.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned.slice(0, 140);
}

function sanitizeWavFilename(raw, fallback = 'audio_item') {
  const baseRaw = (raw || '').trim().replace(/\.(wav|mp3)$/i, '');
  const safeBase = sanitizeSegment(baseRaw, fallback).replace(/\.wav$/i, '');
  return `${safeBase || fallback}.wav`;
}

function normalizeUrlKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return urlStr || '';
  }
}

async function persistState() {
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: sessionState });
  chrome.runtime.sendMessage({
    target: 'popup',
    type: 'STATE_UPDATED',
    state: sessionState
  }).catch(() => {
    // Popup may be closed
  });
}

async function persistSettings() {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: recorderSettings });
}

function appendLog(entry) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: entry.type || 'info',
    fileName: entry.fileName || '',
    durationSec: typeof entry.durationSec === 'number' ? entry.durationSec : null,
    detail: entry.detail || ''
  };
  sessionState.logs.unshift(item);
  if (sessionState.logs.length > MAX_LOG_ENTRIES) {
    sessionState.logs.length = MAX_LOG_ENTRIES;
  }
}

/**
 * Checks whether the offscreen document currently exists.
 */
async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }
  const matchedClients = await self.clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

/**
 * Ensures a single offscreen document with reason USER_MEDIA exists.
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }
  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture active tab audio via Web Audio AudioWorkletNode and encode 16-bit PCM WAV files.'
  });
  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function closeOffscreenDocumentIfOpen() {
  if (closeOffscreenFallbackTimer) {
    clearTimeout(closeOffscreenFallbackTimer);
    closeOffscreenFallbackTimer = null;
  }
  pendingCloseOffscreenAfterDownloads = false;
  if (await hasOffscreenDocument()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {
      // Already closed
    }
  }
}

async function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ ...payload, target: 'offscreen' });
}

/**
 * Ensures content.js is loaded in the target tab and responsive.
 */
async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' });
    if (ping && ping.ok) {
      return;
    }
  } catch (_) {
    // Not injected yet
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

function isCapturableUrl(url) {
  if (!url) return false;
  return /^(https?|file):\/\//i.test(url);
}

/**
 * Initializes tab audio capture in the offscreen document for targetTabId.
 */
async function setupTabAudioCapture(targetTabId) {
  pendingCloseOffscreenAfterDownloads = false;
  if (closeOffscreenFallbackTimer) {
    clearTimeout(closeOffscreenFallbackTimer);
    closeOffscreenFallbackTimer = null;
  }

  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!id) {
        reject(new Error('Failed to acquire tab capture media stream ID.'));
      } else {
        resolve(id);
      }
    });
  });

  await ensureOffscreenDocument();

  const initRes = await sendToOffscreen({
    type: 'INIT_CAPTURE',
    streamId,
    silentMode: recorderSettings.silentMode,
    autoTrimLeading: recorderSettings.autoTrimLeading
  });

  if (!initRes || !initRes.ok) {
    throw new Error(initRes?.error || 'Offscreen audio capture initialization failed.');
  }

  return initRes;
}

/**
 * Tears down audio capture cleanly and closes offscreen document once pending downloads settle.
 */
async function teardownSessionAudio({ waitForDownloads = true } = {}) {
  const hasDoc = await hasOffscreenDocument();
  if (!hasDoc) return;

  const hasPending = waitForDownloads && pendingDownloads.size > 0;
  try {
    await sendToOffscreen({
      type: 'TEARDOWN_CAPTURE',
      preservePendingBlobs: hasPending
    });
  } catch (_) {
    // Offscreen may already be unloading
  }

  if (hasPending) {
    pendingCloseOffscreenAfterDownloads = true;
    if (closeOffscreenFallbackTimer) clearTimeout(closeOffscreenFallbackTimer);
    closeOffscreenFallbackTimer = setTimeout(() => {
      closeOffscreenDocumentIfOpen();
    }, 15000);
  } else {
    await closeOffscreenDocumentIfOpen();
  }
}

/**
 * Starts a full batch recording session on the active tab.
 */
async function handleStartBatch(requestedTabId) {
  const tab = requestedTabId
    ? await chrome.tabs.get(requestedTabId)
    : await getActiveTab();

  if (!tab || !tab.id) {
    throw new Error('No active browser tab found.');
  }
  if (!isCapturableUrl(tab.url)) {
    throw new Error('Cannot record browser internal pages (chrome://, edge://, about:). Switch to an http(s):// or file:// tab.');
  }

  // Tear down any lingering previous session cleanly
  if (sessionState.tabId && (sessionState.status === 'running' || sessionState.status === 'paused')) {
    try {
      await chrome.tabs.sendMessage(sessionState.tabId, { type: 'SEQUENCER_STOP' });
    } catch (_) {}
    await teardownSessionAudio({ waitForDownloads: false });
  }

  await ensureContentScript(tab.id);
  const captureInfo = await setupTabAudioCapture(tab.id);

  sessionState = {
    ...sessionState,
    status: 'running',
    tabId: tab.id,
    tabUrl: tab.url || '',
    currentFile: '',
    processedCount: 0,
    totalCount: 0,
    skippedCount: 0,
    errorMessage: '',
    startedAt: Date.now()
  };

  appendLog({
    type: 'info',
    detail: `Batch started (${captureInfo.sampleRate} Hz 16-bit Stereo PCM)`
  });
  await persistState();

  const seqRes = await chrome.tabs.sendMessage(tab.id, {
    type: 'SEQUENCER_START',
    settings: recorderSettings
  });

  if (!seqRes || !seqRes.ok) {
    await teardownSessionAudio({ waitForDownloads: false });
    sessionState.status = 'error';
    sessionState.errorMessage = seqRes?.error || 'Failed to start DOM sequencer on target tab.';
    appendLog({ type: 'error', detail: sessionState.errorMessage });
    await persistState();
    throw new Error(sessionState.errorMessage);
  }

  return { ok: true, state: sessionState };
}

async function handlePauseBatch() {
  if (sessionState.status !== 'running' || !sessionState.tabId) {
    return { ok: false, error: 'No running session to pause.' };
  }
  sessionState.status = 'paused';
  sessionState.currentFile = '';
  appendLog({ type: 'info', detail: 'Session paused' });
  await persistState();

  try {
    await chrome.tabs.sendMessage(sessionState.tabId, { type: 'SEQUENCER_PAUSE' });
  } catch (_) {}

  return { ok: true, state: sessionState };
}

async function handleResumeBatch() {
  if (sessionState.status !== 'paused' || !sessionState.tabId) {
    return { ok: false, error: 'No paused session to resume.' };
  }

  // Ensure offscreen capture graph is still ready
  let captureReady = false;
  if (await hasOffscreenDocument()) {
    try {
      const ping = await sendToOffscreen({ type: 'OFFSCREEN_PING' });
      captureReady = Boolean(ping && ping.ok && ping.captureReady);
    } catch (_) {}
  }

  if (!captureReady) {
    await setupTabAudioCapture(sessionState.tabId);
  }

  sessionState.status = 'running';
  sessionState.errorMessage = '';
  appendLog({ type: 'info', detail: 'Session resumed' });
  await persistState();

  try {
    await chrome.tabs.sendMessage(sessionState.tabId, {
      type: 'SEQUENCER_RESUME',
      settings: recorderSettings
    });
  } catch (err) {
    sessionState.status = 'error';
    sessionState.errorMessage = `Unable to resume target tab: ${err.message}`;
    appendLog({ type: 'error', detail: sessionState.errorMessage });
    await persistState();
    await teardownSessionAudio({ waitForDownloads: false });
    return { ok: false, error: sessionState.errorMessage };
  }

  return { ok: true, state: sessionState };
}

async function handleSkipCurrent() {
  if (sessionState.status !== 'running' || !sessionState.tabId) {
    return { ok: false, error: 'No active recording to skip.' };
  }
  try {
    await chrome.tabs.sendMessage(sessionState.tabId, { type: 'SEQUENCER_SKIP' });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

async function handleStopBatch(reason = 'Stopped by user') {
  const targetTabId = sessionState.tabId;

  if (targetTabId) {
    try {
      await chrome.tabs.sendMessage(targetTabId, { type: 'SEQUENCER_STOP' });
    } catch (_) {
      // Tab may already be closed or navigated away
    }
  }

  await teardownSessionAudio({ waitForDownloads: true });

  sessionState.status = 'idle';
  sessionState.currentFile = '';
  sessionState.errorMessage = '';
  appendLog({ type: 'info', detail: reason });
  await persistState();

  return { ok: true, state: sessionState };
}

async function handleClearSessionCache() {
  const tab = await getActiveTab();
  const urlToClear = tab?.url || sessionState.tabUrl;
  const urlKey = normalizeUrlKey(urlToClear);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROCESSED_BY_URL);
  const map = stored[STORAGE_KEYS.PROCESSED_BY_URL] || {};
  if (urlKey && map[urlKey]) {
    delete map[urlKey];
    await chrome.storage.local.set({ [STORAGE_KEYS.PROCESSED_BY_URL]: map });
  }

  if (tab?.id && isCapturableUrl(tab.url)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SEQUENCER_CLEAR_CACHE' });
    } catch (_) {
      // Content script may not be loaded on this tab yet
    }
  }

  if (sessionState.status !== 'running') {
    sessionState.processedCount = 0;
    sessionState.skippedCount = 0;
    sessionState.totalCount = 0;
    sessionState.currentFile = '';
    if (sessionState.status === 'completed' || sessionState.status === 'error') {
      sessionState.status = 'idle';
      sessionState.errorMessage = '';
    }
  }

  appendLog({ type: 'info', detail: 'Cleared processed session cache for active page' });
  await persistState();

  return { ok: true, state: sessionState };
}

async function handleTestSelectors(selectors) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    throw new Error('No active browser tab found.');
  }
  if (!isCapturableUrl(tab.url)) {
    throw new Error('Cannot inspect browser internal pages. Open an http(s):// or file:// page.');
  }

  await ensureContentScript(tab.id);
  const res = await chrome.tabs.sendMessage(tab.id, {
    type: 'SEQUENCER_TEST_SELECTORS',
    selectors: selectors || recorderSettings.selectors
  });

  if (res && res.ok && sessionState.status === 'idle') {
    sessionState.folderName = res.collectionTitle || sessionState.folderName;
    sessionState.totalCount = res.count || 0;
    await persistState();
  }

  return res;
}

/**
 * Handles START_RECORDING from content.js -> arms AudioWorklet buffer in offscreen.js.
 */
async function handleItemStartRecording(message, sender) {
  const tabId = sender?.tab?.id || sessionState.tabId;
  const safeFolder = sanitizeSegment(message.folderName, 'Session');
  const safeFile = sanitizeWavFilename(message.fileName, `item_${Date.now()}`);
  const recordingId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Ensure offscreen audio capture graph is alive
  let ready = false;
  if (await hasOffscreenDocument()) {
    try {
      const ping = await sendToOffscreen({ type: 'OFFSCREEN_PING' });
      ready = Boolean(ping && ping.ok && ping.captureReady);
    } catch (_) {}
  }
  if (!ready && tabId) {
    await setupTabAudioCapture(tabId);
  }

  const startRes = await sendToOffscreen({
    type: 'START_ITEM_RECORDING',
    recordingId,
    autoTrimLeading: recorderSettings.autoTrimLeading
  });

  if (!startRes || !startRes.ok) {
    throw new Error(startRes?.error || 'Offscreen failed to start item recording.');
  }

  sessionState.folderName = safeFolder;
  sessionState.currentFile = safeFile;
  if (typeof message.processedCount === 'number') {
    sessionState.processedCount = message.processedCount;
  }
  if (typeof message.totalCount === 'number') {
    sessionState.totalCount = message.totalCount;
  }
  await persistState();

  return {
    ok: true,
    type: 'RECORDING_READY',
    recordingId,
    folderName: safeFolder,
    fileName: safeFile
  };
}

/**
 * Handles STOP_AND_SAVE from content.js -> encodes WAV in offscreen.js -> downloads via chrome.downloads.
 */
async function handleItemStopAndSave(message) {
  const safeFolder = sanitizeSegment(message.folderName || sessionState.folderName, 'Session');
  const safeFile = sanitizeWavFilename(message.fileName || sessionState.currentFile, `item_${Date.now()}`);

  const encodeRes = await sendToOffscreen({
    type: 'STOP_AND_ENCODE',
    recordingId: message.recordingId,
    autoTrimLeading: recorderSettings.autoTrimLeading
  });

  if (!encodeRes || !encodeRes.ok || !encodeRes.blobUrl) {
    throw new Error(encodeRes?.error || 'Failed to encode WAV file in offscreen document.');
  }

  const downloadFilename = `Recorded_Sessions/${safeFolder}/${safeFile}`;

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: encodeRes.blobUrl,
      filename: downloadFilename,
      conflictAction: 'overwrite',
      saveAs: false
    });
  } catch (err) {
    // Immediately revoke Blob URL if download call failed
    sendToOffscreen({ type: 'REVOKE_BLOB_URL', blobUrl: encodeRes.blobUrl }).catch(() => {});
    throw err;
  }

  pendingDownloads.set(downloadId, encodeRes.blobUrl);

  if (typeof message.processedCount === 'number') {
    sessionState.processedCount = message.processedCount;
  }
  if (typeof message.totalCount === 'number') {
    sessionState.totalCount = message.totalCount;
  }
  sessionState.currentFile = '';

  const trimInfo = `trim -${encodeRes.trimmedLeadingMs}ms/-${encodeRes.trimmedTrailingMs}ms`;
  appendLog({
    type: encodeRes.silentWarning ? 'warn' : 'saved',
    fileName: safeFile,
    durationSec: encodeRes.durationSec,
    detail: encodeRes.silentWarning ? 'No signal above -60 dBFS' : trimInfo
  });
  await persistState();

  return {
    ok: true,
    type: 'SAVED_OK',
    downloadId,
    durationSec: encodeRes.durationSec,
    silentWarning: encodeRes.silentWarning
  };
}

async function handleDiscardRecording(message) {
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ type: 'DISCARD_ITEM_RECORDING' }).catch(() => {});
  }
  sessionState.currentFile = '';
  if (typeof message.processedCount === 'number') {
    sessionState.processedCount = message.processedCount;
  }
  if (typeof message.totalCount === 'number') {
    sessionState.totalCount = message.totalCount;
  }
  if (message.reason === 'skip') {
    sessionState.skippedCount = (sessionState.skippedCount || 0) + 1;
    appendLog({
      type: 'skip',
      fileName: message.fileName || '',
      detail: 'Skipped item'
    });
  }
  await persistState();
  return { ok: true };
}

async function handleCheckFileExists(message) {
  const safeFolder = sanitizeSegment(message.folderName || sessionState.folderName, 'Session');
  const safeFile = sanitizeWavFilename(message.fileName, 'audio_item');
  const expectedRelPath = `recorded_sessions/${safeFolder}/${safeFile}`.replace(/\\/g, '/').toLowerCase();

  const completedDownloads = await chrome.downloads.search({
    state: 'complete',
    exists: true
  });

  const match = completedDownloads.find((item) => {
    if (!item || !item.filename) return false;
    const normalized = item.filename.replace(/\\/g, '/').toLowerCase();
    return normalized === expectedRelPath || normalized.endsWith(`/${expectedRelPath}`);
  });

  return {
    ok: true,
    exists: Boolean(match),
    matchedPath: match ? match.filename : null
  };
}

// Keepalive Port Listener from offscreen.js
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-keepalive') return;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PING') {
      try {
        port.postMessage({ type: 'PONG', ts: Date.now() });
      } catch (_) {}
    }
  });
});

// Download Completion Listener -> immediate Blob URL revocation & deferred offscreen close
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta || typeof delta.id !== 'number' || !delta.state) return;
  const currentState = delta.state.current;
  if (currentState !== 'complete' && currentState !== 'interrupted') return;

  const blobUrl = pendingDownloads.get(delta.id);
  if (!blobUrl) return;

  pendingDownloads.delete(delta.id);
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ type: 'REVOKE_BLOB_URL', blobUrl }).catch(() => {});
  }

  if (pendingCloseOffscreenAfterDownloads && pendingDownloads.size === 0) {
    await closeOffscreenDocumentIfOpen();
  }
});

// Tab Removal Safety Net
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureInitialized();
  if (sessionState.tabId === tabId && (sessionState.status === 'running' || sessionState.status === 'paused')) {
    await teardownSessionAudio({ waitForDownloads: true });
    sessionState.status = 'idle';
    sessionState.tabId = null;
    sessionState.currentFile = '';
    appendLog({ type: 'warn', detail: 'Target tab closed; capture stopped and resources released.' });
    await persistState();
  }
});

// Main Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (message.target && message.target !== 'background')) {
    return false;
  }

  (async () => {
    try {
      await ensureInitialized();

      switch (message.type) {
        case 'GET_STATE':
          sendResponse({ ok: true, state: sessionState, settings: recorderSettings });
          break;

        case 'UPDATE_SETTINGS': {
          recorderSettings = mergeSettings(recorderSettings, message.settings);
          await persistSettings();

          if (await hasOffscreenDocument()) {
            sendToOffscreen({
              type: 'UPDATE_AUDIO_SETTINGS',
              silentMode: recorderSettings.silentMode,
              autoTrimLeading: recorderSettings.autoTrimLeading
            }).catch(() => {});
          }

          if (sessionState.tabId && (sessionState.status === 'running' || sessionState.status === 'paused')) {
            chrome.tabs.sendMessage(sessionState.tabId, {
              type: 'SEQUENCER_UPDATE_SETTINGS',
              settings: recorderSettings
            }).catch(() => {});
          }

          sendResponse({ ok: true, settings: recorderSettings });
          break;
        }

        case 'START_BATCH':
          sendResponse(await handleStartBatch(message.tabId));
          break;

        case 'PAUSE_BATCH':
          sendResponse(await handlePauseBatch());
          break;

        case 'RESUME_BATCH':
          sendResponse(await handleResumeBatch());
          break;

        case 'SKIP_CURRENT':
          sendResponse(await handleSkipCurrent());
          break;

        case 'STOP_BATCH':
          sendResponse(await handleStopBatch('Batch stopped by user'));
          break;

        case 'CLEAR_SESSION_CACHE':
          sendResponse(await handleClearSessionCache());
          break;

        case 'CLEAR_LOG':
          sessionState.logs = [];
          await persistState();
          sendResponse({ ok: true, state: sessionState });
          break;

        case 'TEST_SELECTORS':
          sendResponse(await handleTestSelectors(message.selectors));
          break;

        case 'CHECK_FILE_EXISTS':
          sendResponse(await handleCheckFileExists(message));
          break;

        case 'START_RECORDING':
          sendResponse(await handleItemStartRecording(message, sender));
          break;

        case 'STOP_AND_SAVE':
          sendResponse(await handleItemStopAndSave(message));
          break;

        case 'DISCARD_RECORDING':
          sendResponse(await handleDiscardRecording(message));
          break;

        case 'SEQUENCER_PROGRESS':
          if (typeof message.folderName === 'string') sessionState.folderName = sanitizeSegment(message.folderName, 'Session');
          if (typeof message.processedCount === 'number') sessionState.processedCount = message.processedCount;
          if (typeof message.totalCount === 'number') sessionState.totalCount = message.totalCount;
          if (typeof message.currentFile === 'string') sessionState.currentFile = message.currentFile;
          if (message.incrementSkipped) sessionState.skippedCount = (sessionState.skippedCount || 0) + 1;
          await persistState();
          sendResponse({ ok: true });
          break;

        case 'SEQUENCER_COMPLETE':
          await teardownSessionAudio({ waitForDownloads: true });
          sessionState.status = 'completed';
          sessionState.currentFile = '';
          if (typeof message.folderName === 'string') sessionState.folderName = sanitizeSegment(message.folderName, 'Session');
          if (typeof message.processedCount === 'number') sessionState.processedCount = message.processedCount;
          if (typeof message.totalCount === 'number') sessionState.totalCount = message.totalCount;
          appendLog({
            type: 'info',
            detail: `Session complete (${sessionState.processedCount} processed${sessionState.skippedCount ? `, ${sessionState.skippedCount} skipped` : ''})`
          });
          await persistState();
          sendResponse({ ok: true });
          break;

        case 'SEQUENCER_ERROR':
          await teardownSessionAudio({ waitForDownloads: true });
          sessionState.status = 'error';
          sessionState.currentFile = '';
          sessionState.errorMessage = message.error || 'Unknown sequencer error';
          appendLog({ type: 'error', detail: sessionState.errorMessage });
          await persistState();
          sendResponse({ ok: true });
          break;

        case 'SEQUENCER_LOG':
          appendLog({
            type: message.level || 'info',
            fileName: message.fileName || '',
            detail: message.detail || ''
          });
          await persistState();
          sendResponse({ ok: true });
          break;

        case 'WATCHDOG_TRIGGER': {
          const detail = message.reason === 'max_duration'
            ? `Watchdog: 40s max duration reached (${message.totalSec?.toFixed(1)}s)`
            : `Watchdog: 1.5s silence after onset (${message.totalSec?.toFixed(1)}s)`;
          appendLog({ type: 'info', fileName: sessionState.currentFile, detail });
          await persistState();

          if (sessionState.tabId && sessionState.status === 'running') {
            chrome.tabs.sendMessage(sessionState.tabId, {
              type: 'SEQUENCER_WATCHDOG_STOP',
              recordingId: message.recordingId,
              reason: message.reason
            }).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        case 'CAPTURE_STREAM_ENDED': {
          if (sessionState.status === 'running' || sessionState.status === 'paused') {
            if (sessionState.tabId) {
              chrome.tabs.sendMessage(sessionState.tabId, { type: 'SEQUENCER_STOP' }).catch(() => {});
            }
            await teardownSessionAudio({ waitForDownloads: true });
            sessionState.status = 'error';
            sessionState.currentFile = '';
            sessionState.errorMessage = 'Tab audio capture stream ended.';
            appendLog({ type: 'error', detail: sessionState.errorMessage });
            await persistState();
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
