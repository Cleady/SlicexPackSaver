/**
 * popup.js
 * Controls the DAW-inspired popup UI, persists settings, runs live selector tests,
 * and stays synchronized with background.js session state.
 */

'use strict';

const DEFAULT_SELECTORS = {
  collectionTitleSelector: 'h1',
  rowSelector: '[data-testid*="sample"], [role="row"], tr',
  itemNameSelector: '[data-testid*="filename"], .filename, a, span',
  playButtonSelector: 'button[aria-label*="Play" i], button[aria-label*="Pause" i], button',
  paginationSelector: 'button[aria-label*="next" i], a[aria-label*="next" i], [class*="pagination"] button'
};

// DOM References
const elStatusBadge = document.getElementById('statusBadge');
const elStatusText = document.getElementById('statusText');
const elErrorBanner = document.getElementById('errorBanner');
const elErrorMessage = document.getElementById('errorMessage');
const elFolderName = document.getElementById('folderName');
const elCurrentFile = document.getElementById('currentFile');
const elProgressText = document.getElementById('progressText');
const elProgressFill = document.getElementById('progressFill');
const elProgressTrack = document.querySelector('.progress-track');

const btnStart = document.getElementById('btnStart');
const btnPauseResume = document.getElementById('btnPauseResume');
const btnSkip = document.getElementById('btnSkip');
const btnStop = document.getElementById('btnStop');
const btnClearCache = document.getElementById('btnClearCache');
const btnClearLog = document.getElementById('btnClearLog');

const toggleSilentMode = document.getElementById('toggleSilentMode');
const toggleAutoTrim = document.getElementById('toggleAutoTrim');
const toggleSkipExisting = document.getElementById('toggleSkipExisting');
const inputTailBuffer = document.getElementById('inputTailBuffer');
const inputIntervalDelay = document.getElementById('inputIntervalDelay');

const selCollectionTitle = document.getElementById('selCollectionTitle');
const selRow = document.getElementById('selRow');
const selItemName = document.getElementById('selItemName');
const selPlayButton = document.getElementById('selPlayButton');
const selPagination = document.getElementById('selPagination');
const btnTestSelectors = document.getElementById('btnTestSelectors');
const btnResetSelectors = document.getElementById('btnResetSelectors');
const elSelectorTestResult = document.getElementById('selectorTestResult');
const elActivityLog = document.getElementById('activityLog');

let currentState = null;
let settingsDebounceTimer = null;

function sendBg(payload) {
  return chrome.runtime.sendMessage({ ...payload, target: 'background' });
}

function showInlineError(msg) {
  if (!msg) {
    elErrorBanner.classList.add('hidden');
    elErrorMessage.textContent = '';
    return;
  }
  elErrorMessage.textContent = msg;
  elErrorBanner.classList.remove('hidden');
}

function showSelectorTestResult(kind, text) {
  elSelectorTestResult.className = `test-result ${kind}`;
  elSelectorTestResult.textContent = text;
  elSelectorTestResult.classList.remove('hidden');
}

function readSettingsFromUI() {
  return {
    silentMode: toggleSilentMode.checked,
    autoTrimLeading: toggleAutoTrim.checked,
    skipExistingFiles: toggleSkipExisting.checked,
    tailBufferMs: Number.parseInt(inputTailBuffer.value, 10) || 150,
    intervalDelayMs: Number.parseInt(inputIntervalDelay.value, 10) || 500,
    selectors: {
      collectionTitleSelector: selCollectionTitle.value.trim() || DEFAULT_SELECTORS.collectionTitleSelector,
      rowSelector: selRow.value.trim() || DEFAULT_SELECTORS.rowSelector,
      itemNameSelector: selItemName.value.trim() || DEFAULT_SELECTORS.itemNameSelector,
      playButtonSelector: selPlayButton.value.trim() || DEFAULT_SELECTORS.playButtonSelector,
      paginationSelector: selPagination.value.trim() || DEFAULT_SELECTORS.paginationSelector
    }
  };
}

function populateSettingsUI(settings) {
  if (!settings) return;
  toggleSilentMode.checked = Boolean(settings.silentMode);
  toggleAutoTrim.checked = settings.autoTrimLeading !== false;
  toggleSkipExisting.checked = settings.skipExistingFiles !== false;
  inputTailBuffer.value = settings.tailBufferMs ?? 150;
  inputIntervalDelay.value = settings.intervalDelayMs ?? 500;

  const s = settings.selectors || DEFAULT_SELECTORS;
  selCollectionTitle.value = s.collectionTitleSelector || DEFAULT_SELECTORS.collectionTitleSelector;
  selRow.value = s.rowSelector || DEFAULT_SELECTORS.rowSelector;
  selItemName.value = s.itemNameSelector || DEFAULT_SELECTORS.itemNameSelector;
  selPlayButton.value = s.playButtonSelector || DEFAULT_SELECTORS.playButtonSelector;
  selPagination.value = s.paginationSelector || DEFAULT_SELECTORS.paginationSelector;
}

function persistSettingsImmediate() {
  if (settingsDebounceTimer) {
    clearTimeout(settingsDebounceTimer);
    settingsDebounceTimer = null;
  }
  return sendBg({ type: 'UPDATE_SETTINGS', settings: readSettingsFromUI() });
}

function persistSettingsDebounced() {
  if (settingsDebounceTimer) clearTimeout(settingsDebounceTimer);
  settingsDebounceTimer = setTimeout(() => {
    settingsDebounceTimer = null;
    sendBg({ type: 'UPDATE_SETTINGS', settings: readSettingsFromUI() }).catch(() => {});
  }, 200);
}

function renderState(state) {
  if (!state) return;
  currentState = state;

  const status = state.status || 'idle';
  const statusLabels = {
    idle: 'IDLE',
    running: 'REC',
    paused: 'PAUSED',
    completed: 'DONE',
    error: 'ERROR'
  };

  elStatusBadge.className = `status-badge status-${status}`;
  elStatusText.textContent = statusLabels[status] || status.toUpperCase();

  showInlineError(status === 'error' ? state.errorMessage : '');

  const folder = state.folderName || '—';
  elFolderName.textContent = folder;
  elFolderName.title = folder;

  let currentLabel = 'Idle';
  if (status === 'running') {
    currentLabel = state.currentFile || 'Scanning list...';
  } else if (status === 'paused') {
    currentLabel = 'Paused';
  } else if (status === 'completed') {
    currentLabel = 'Batch Complete';
  } else if (status === 'error') {
    currentLabel = 'Stopped on Error';
  }
  elCurrentFile.textContent = currentLabel;
  elCurrentFile.title = currentLabel;

  const processed = Number(state.processedCount) || 0;
  const total = Math.max(processed, Number(state.totalCount) || 0);
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  elProgressText.textContent = `${processed} / ${total}`;
  elProgressFill.style.width = `${pct}%`;
  elProgressTrack.setAttribute('aria-valuenow', String(pct));

  // Button states
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isActive = isRunning || isPaused;

  btnStart.disabled = isActive;
  btnPauseResume.disabled = !isActive;
  btnPauseResume.textContent = isPaused ? 'Resume' : 'Pause';
  btnSkip.disabled = !isRunning;
  btnStop.disabled = !isActive;

  renderLogs(state.logs || []);
}

function renderLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    elActivityLog.innerHTML = '<div class="log-empty">No activity yet. Click "Test Selectors" or "Start Batch".</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  const tagMap = {
    saved: 'WAV',
    skip: 'SKIP',
    warn: 'WARN',
    error: 'ERR',
    info: 'SYS'
  };

  for (const entry of logs.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'log-item';

    const left = document.createElement('div');
    left.className = 'log-left';

    const timeEl = document.createElement('span');
    timeEl.className = 'log-time';
    timeEl.textContent = entry.timestamp || '';

    const tagEl = document.createElement('span');
    tagEl.className = `log-tag ${entry.type || 'info'}`;
    tagEl.textContent = tagMap[entry.type] || 'LOG';

    const msgEl = document.createElement('span');
    msgEl.className = 'log-msg';
    const text = entry.fileName
      ? (entry.detail && entry.type !== 'saved' ? `${entry.fileName} — ${entry.detail}` : entry.fileName)
      : (entry.detail || '');
    msgEl.textContent = text;
    msgEl.title = entry.detail ? `${entry.fileName ? `${entry.fileName}: ` : ''}${entry.detail}` : text;

    left.append(timeEl, tagEl, msgEl);
    row.appendChild(left);

    if (typeof entry.durationSec === 'number') {
      const durEl = document.createElement('span');
      durEl.className = 'log-dur';
      durEl.textContent = `${entry.durationSec.toFixed(2)}s`;
      row.appendChild(durEl);
    }

    fragment.appendChild(row);
  }

  elActivityLog.replaceChildren(fragment);
}

// Event Handlers
btnStart.addEventListener('click', async () => {
  showInlineError('');
  btnStart.disabled = true;
  try {
    await persistSettingsImmediate();
    const res = await sendBg({ type: 'START_BATCH' });
    if (!res || !res.ok) {
      showInlineError(res?.error || 'Failed to start batch recording.');
      btnStart.disabled = false;
      return;
    }
    if (res.state) renderState(res.state);
  } catch (err) {
    showInlineError(err?.message || String(err));
    btnStart.disabled = false;
  }
});

btnPauseResume.addEventListener('click', async () => {
  showInlineError('');
  if (!currentState) return;
  const action = currentState.status === 'paused' ? 'RESUME_BATCH' : 'PAUSE_BATCH';
  try {
    const res = await sendBg({ type: action });
    if (!res || !res.ok) {
      showInlineError(res?.error || 'Action failed.');
      return;
    }
    if (res.state) renderState(res.state);
  } catch (err) {
    showInlineError(err?.message || String(err));
  }
});

btnSkip.addEventListener('click', async () => {
  showInlineError('');
  try {
    const res = await sendBg({ type: 'SKIP_CURRENT' });
    if (!res || !res.ok) {
      showInlineError(res?.error || 'Unable to skip current item.');
    }
  } catch (err) {
    showInlineError(err?.message || String(err));
  }
});

btnStop.addEventListener('click', async () => {
  showInlineError('');
  try {
    const res = await sendBg({ type: 'STOP_BATCH' });
    if (res?.state) renderState(res.state);
  } catch (err) {
    showInlineError(err?.message || String(err));
  }
});

btnClearCache.addEventListener('click', async () => {
  showInlineError('');
  try {
    const res = await sendBg({ type: 'CLEAR_SESSION_CACHE' });
    if (res?.state) renderState(res.state);
  } catch (err) {
    showInlineError(err?.message || String(err));
  }
});

btnClearLog.addEventListener('click', async () => {
  try {
    const res = await sendBg({ type: 'CLEAR_LOG' });
    if (res?.state) renderState(res.state);
  } catch (_) {}
});

toggleSilentMode.addEventListener('change', () => {
  persistSettingsImmediate().catch(() => {});
});

toggleAutoTrim.addEventListener('change', () => {
  persistSettingsImmediate().catch(() => {});
});

toggleSkipExisting.addEventListener('change', () => {
  persistSettingsImmediate().catch(() => {});
});

inputTailBuffer.addEventListener('input', persistSettingsDebounced);
inputIntervalDelay.addEventListener('input', persistSettingsDebounced);
selCollectionTitle.addEventListener('input', persistSettingsDebounced);
selRow.addEventListener('input', persistSettingsDebounced);
selItemName.addEventListener('input', persistSettingsDebounced);
selPlayButton.addEventListener('input', persistSettingsDebounced);
selPagination.addEventListener('input', persistSettingsDebounced);

btnTestSelectors.addEventListener('click', async () => {
  showInlineError('');
  btnTestSelectors.disabled = true;
  try {
    await persistSettingsImmediate();
    const { selectors } = readSettingsFromUI();
    const res = await sendBg({ type: 'TEST_SELECTORS', selectors });

    if (!res || !res.ok) {
      showSelectorTestResult('err', res?.error || 'Selector test failed.');
      return;
    }

    let paginationNote = '';
    if (res.pagination) {
      if (res.pagination.status === 'found') {
        paginationNote = res.pagination.mode === 'numbered'
          ? ` • Next: Page ${res.pagination.targetPage}`
          : ` • Next: "${res.pagination.label || 'Next'}"`;
      } else if (res.pagination.status === 'end_of_pages') {
        paginationNote = res.pagination.currentPage
          ? ` • Pagination: on last page (${res.pagination.currentPage})`
          : ' • Pagination: Next disabled (last page)';
      }
    }

    if (res.count === 0) {
      showSelectorTestResult(
        'warn',
        `Found 0 playable rows (${res.totalRawRows} raw rows matched without a visible play button). Collection: "${res.collectionTitle}".${paginationNote}`
      );
    } else {
      const preview = res.sampleNames?.length
        ? ` Preview: ${res.sampleNames.slice(0, 3).join(', ')}${res.count > 3 ? '…' : ''}`
        : '';
      showSelectorTestResult(
        'ok',
        `Found ${res.count} playable item${res.count === 1 ? '' : 's'} • Folder: "${res.collectionTitle}"${paginationNote}.${preview}`
      );
    }
  } catch (err) {
    showSelectorTestResult('err', err?.message || String(err));
  } finally {
    btnTestSelectors.disabled = false;
  }
});

btnResetSelectors.addEventListener('click', async () => {
  selCollectionTitle.value = DEFAULT_SELECTORS.collectionTitleSelector;
  selRow.value = DEFAULT_SELECTORS.rowSelector;
  selItemName.value = DEFAULT_SELECTORS.itemNameSelector;
  selPlayButton.value = DEFAULT_SELECTORS.playButtonSelector;
  selPagination.value = DEFAULT_SELECTORS.paginationSelector;
  await persistSettingsImmediate();
  showSelectorTestResult('ok', 'Selectors reset to defaults.');
});

// Listen for real-time state broadcasts from background.js
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.target === 'popup' && message.type === 'STATE_UPDATED') {
    renderState(message.state);
  }
});

// Initial Hydration on Popup Open
(async function initPopup() {
  try {
    const res = await sendBg({ type: 'GET_STATE' });
    if (res && res.ok) {
      populateSettingsUI(res.settings);
      renderState(res.state);
    }
  } catch (err) {
    showInlineError(`Failed to connect to background service worker: ${err?.message || err}`);
  }
})();
