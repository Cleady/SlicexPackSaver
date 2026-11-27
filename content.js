/**
 * content.js
 * Configurable DOM batch playback sequencer with smooth scrolling,
 * lazy-load/virtualized list support, MutationObserver playback detection,
 * and Pause/Resume/Skip/Stop controls.
 */

(() => {
  'use strict';

  if (window.__TAB_AUDIO_BATCH_RECORDER_LOADED__) {
    return;
  }
  window.__TAB_AUDIO_BATCH_RECORDER_LOADED__ = true;

  const STORAGE_KEY_PROCESSED = 'processedItemsByUrl';
  const HIGHLIGHT_CLASS = 'tab-audio-batch-rec-active';
  const TEST_HIGHLIGHT_CLASS = 'tab-audio-batch-rec-test';
  const STYLE_ELEMENT_ID = 'tab-audio-batch-rec-styles';
  const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const LOAD_MORE_RE = /^(load\s*more|show\s*more|view\s*more|more\s*results|more\s*items)$/i;
  const TIMESTAMP_ONLY_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const PAGINATION_POLL_INTERVAL_MS = 200;
  const PAGINATION_WAIT_TIMEOUT_MS = 5000;

  const DEFAULT_SETTINGS = {
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

  // Sequencer Runtime State
  let settings = structuredClone(DEFAULT_SETTINGS);
  let state = 'idle'; // 'idle' | 'running' | 'paused' | 'stopping'
  let processedSet = new Set();
  let visitedThisRun = new Set();
  let knownItems = new Set();
  let activeRowEl = null;
  let activeObserver = null;
  let currentRecordingId = null;
  let currentPlaybackResolver = null;
  let sleepAbortResolvers = new Set();
  let pauseResumeResolvers = new Set();
  let testHighlightTimer = null;

  function ensureStylesInjected() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 2px solid #22d3ee !important;
        outline-offset: -2px !important;
        box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.22) !important;
        transition: outline 150ms ease, box-shadow 150ms ease !important;
      }
      .${TEST_HIGHLIGHT_CLASS} {
        outline: 2px dashed #22d3ee !important;
        outline-offset: -2px !important;
        background-color: rgba(34, 211, 238, 0.08) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getPageUrlKey() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  function sanitizeName(raw, fallback = 'Untitled') {
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

  function formatWavFilename(rawName, fallbackIndex) {
    const trimmed = (rawName || '').trim();
    const withoutExt = trimmed.replace(/\.(wav|mp3)$/i, '');
    const safeBase = sanitizeName(withoutExt, `audio_item_${fallbackIndex}`).replace(/\.wav$/i, '');
    return `${safeBase || `audio_item_${fallbackIndex}`}.wav`;
  }

  async function loadProcessedSet() {
    const key = getPageUrlKey();
    const stored = await chrome.storage.local.get(STORAGE_KEY_PROCESSED);
    const map = stored[STORAGE_KEY_PROCESSED] || {};
    const list = Array.isArray(map[key]) ? map[key] : [];
    processedSet = new Set(list);
    visitedThisRun = new Set();
    knownItems = new Set();
  }

  async function saveProcessedSet() {
    const key = getPageUrlKey();
    const stored = await chrome.storage.local.get(STORAGE_KEY_PROCESSED);
    const map = stored[STORAGE_KEY_PROCESSED] || {};
    map[key] = Array.from(processedSet);
    await chrome.storage.local.set({ [STORAGE_KEY_PROCESSED]: map });
  }

  function clearAllHighlights() {
    if (testHighlightTimer) {
      clearTimeout(testHighlightTimer);
      testHighlightTimer = null;
    }
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
    document.querySelectorAll(`.${TEST_HIGHLIGHT_CLASS}`).forEach((el) => el.classList.remove(TEST_HIGHLIGHT_CLASS));
    activeRowEl = null;
  }

  function setRowHighlight(row) {
    if (activeRowEl && activeRowEl !== row) {
      activeRowEl.classList.remove(HIGHLIGHT_CLASS);
    }
    activeRowEl = row;
    if (row) {
      ensureStylesInjected();
      row.classList.add(HIGHLIGHT_CLASS);
    }
  }

  function removeRowHighlight(row) {
    if (row) row.classList.remove(HIGHLIGHT_CLASS);
    if (activeRowEl === row) activeRowEl = null;
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function safeQueryAll(root, selector, label) {
    if (!selector || !selector.trim()) {
      throw new Error(`Empty CSS selector for ${label}.`);
    }
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (err) {
      throw new Error(`Invalid CSS selector for ${label} ("${selector}"): ${err.message}`);
    }
  }

  function safeQueryOne(root, selector, label) {
    if (!selector || !selector.trim()) return null;
    try {
      return root.querySelector(selector);
    } catch (err) {
      throw new Error(`Invalid CSS selector for ${label} ("${selector}"): ${err.message}`);
    }
  }

  function extractCollectionTitle(selectors) {
    const titleEl = safeQueryOne(document, selectors.collectionTitleSelector, 'Collection Title');
    const raw = titleEl?.textContent?.trim() || document.title?.trim() || 'Recorded_Session';
    return sanitizeName(raw, 'Recorded_Session');
  }

  function extractItemName(row, playBtn, selectors, fallbackIndex) {
    const candidates = safeQueryAll(row, selectors.itemNameSelector, 'Item Name');
    const texts = [];

    for (const el of candidates) {
      // Skip text inside the play button itself unless nothing else exists
      if (playBtn && (el === playBtn || playBtn.contains(el))) continue;
      const text = (
        el.getAttribute('data-filename') ||
        el.textContent ||
        el.getAttribute('title') ||
        el.getAttribute('aria-label') ||
        ''
      ).replace(/\s+/g, ' ').trim();
      if (text) {
        texts.push(text);
      }
    }

    // 1. Prefer explicit .wav filenames
    const wavMatch = texts.find((t) => /\.wav$/i.test(t));
    if (wavMatch) return formatWavFilename(wavMatch, fallbackIndex);

    // 2. Next prefer .mp3 filenames
    const mp3Match = texts.find((t) => /\.mp3$/i.test(t));
    if (mp3Match) return formatWavFilename(mp3Match, fallbackIndex);

    // 3. Prefer non-timestamp, non-control labels
    const semanticLabel = texts.find(
      (t) => !TIMESTAMP_ONLY_RE.test(t) && !/^(play|pause|stop|mute|download)$/i.test(t)
    );
    if (semanticLabel) return formatWavFilename(semanticLabel, fallbackIndex);

    // 4. First non-empty label fallback
    if (texts.length > 0) return formatWavFilename(texts[0], fallbackIndex);

    // 5. Row text fallback
    const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return formatWavFilename(rowText, fallbackIndex);
  }

  function findPlayButton(row, selectors) {
    const buttons = safeQueryAll(row, selectors.playButtonSelector, 'Play Button');
    // Prefer visible, enabled buttons matching play/pause aria-label first
    const visibleButtons = buttons.filter((btn) => isElementVisible(btn) && !btn.disabled);
    const prioritized = visibleButtons.find((btn) => {
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.textContent || ''}`;
      return /\b(play|pause|preview|listen|stop)\b/i.test(label);
    });
    return prioritized || visibleButtons[0] || buttons[0] || null;
  }

  /**
   * Returns all visible playable rows matched by selectors.
   */
  function findPlayableRows(selectors) {
    const rawRows = safeQueryAll(document, selectors.rowSelector, 'Row');
    const items = [];

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      // Skip table headers and invisible/detached nodes
      if (row.closest('thead') || !isElementVisible(row)) continue;

      const playBtn = findPlayButton(row, selectors);
      if (!playBtn) continue;

      const fileName = extractItemName(row, playBtn, selectors, i + 1);
      items.push({ row, playBtn, fileName, key: fileName.toLowerCase() });
    }

    return { items, totalRawRows: rawRows.length };
  }

  /**
   * Finds the nearest scrollable container for a row (supporting virtualized lists) or window.
   */
  function findScrollContainer(el) {
    let curr = el ? el.parentElement : null;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      const style = window.getComputedStyle(curr);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && curr.scrollHeight > curr.clientHeight + 20) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return window;
  }

  function tryClickLoadMoreButton() {
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      if (!isElementVisible(el) || isControlDisabled(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (LOAD_MORE_RE.test(text) || LOAD_MORE_RE.test(aria)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
        return true;
      }
    }
    return false;
  }

  function isControlDisabled(el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (/\bdisabled\b/i.test(el.className || '')) return true;
    const li = el.closest('li');
    if (li && /\bdisabled\b/i.test(li.className || '')) return true;
    return false;
  }

  function isExplicitNextControl(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    const rel = (el.getAttribute('rel') || '').trim().toLowerCase();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const meta = `${aria} ${title} ${el.getAttribute('data-testid') || ''} ${el.className || ''}`;

    if (/\bprev(ious)?\b/i.test(aria) || /\bprev(ious)?\b/i.test(title) || rel === 'prev') {
      return false;
    }
    if (rel === 'next') return true;
    if (/\bnext\b/i.test(aria) || /\bnext\b/i.test(title)) return true;
    if (/^(next(\s*page)?|>|›|»|→)$/i.test(text)) return true;
    if (/\b(next-page|page-next|pagination-next)\b/i.test(meta)) return true;
    return false;
  }

  function isActivePageControl(el) {
    const ariaCurrent = (el.getAttribute('aria-current') || '').toLowerCase();
    if (ariaCurrent === 'page' || ariaCurrent === 'true') return true;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') return true;

    const dataActive = (el.getAttribute('data-active') || el.getAttribute('data-current') || '').toLowerCase();
    if (dataActive === 'true') return true;

    const activeClassRe = /\b(active|current|selected|is-active|is-current|page-active)\b/i;
    if (activeClassRe.test(el.className || '')) return true;

    const li = el.closest('li');
    if (li) {
      const liAriaCurrent = (li.getAttribute('aria-current') || '').toLowerCase();
      if (liAriaCurrent === 'page' || liAriaCurrent === 'true') return true;
      if (activeClassRe.test(li.className || '')) return true;
    }

    return false;
  }

  /**
   * Detects the next pagination button to click:
   * 1. First checks for a visible, enabled explicit "Next" button matching paginationSelector.
   * 2. Otherwise detects the active numbered page button inside the pagination container
   *    and targets the next sequential numbered button (e.g. 1 -> 2 -> 3 -> 4).
   * 3. Returns 'end_of_pages' when pagination exists but no enabled next page remains,
   *    or 'none' when no pagination controls are present on the page.
   */
  function findPaginationAction(selectors) {
    const selector = (selectors.paginationSelector || '').trim();
    if (!selector) {
      return { status: 'none' };
    }

    const matched = safeQueryAll(document, selector, 'Next Page / Pagination').filter(isElementVisible);
    if (matched.length === 0) {
      return { status: 'none' };
    }

    // 1. Check explicit "Next" controls first
    const explicitNextControls = matched.filter(isExplicitNextControl);
    const enabledNext = explicitNextControls.find((el) => !isControlDisabled(el));
    if (enabledNext) {
      const label = (enabledNext.getAttribute('aria-label') || enabledNext.textContent || 'Next').trim();
      return {
        status: 'found',
        element: enabledNext,
        mode: 'next_button',
        label
      };
    }

    const hasDisabledExplicitNext = explicitNextControls.length > 0;

    // 2. Collect numbered page buttons from matched elements and their pagination container(s)
    const candidateSet = new Set(matched);
    for (const el of matched) {
      const container = el.closest('[class*="pagination"], [role="navigation"], nav');
      if (container) {
        container.querySelectorAll('button, a, [role="button"]').forEach((child) => {
          if (isElementVisible(child)) candidateSet.add(child);
        });
      }
    }

    const numberedByPage = new Map();
    for (const el of candidateSet) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^\d+$/.test(text)) {
        const pageNum = Number.parseInt(text, 10);
        if (Number.isFinite(pageNum) && pageNum > 0 && !numberedByPage.has(pageNum)) {
          numberedByPage.set(pageNum, { el, pageNum });
        }
      }
    }

    if (numberedByPage.size > 0) {
      const numberedEntries = Array.from(numberedByPage.values()).sort((a, b) => a.pageNum - b.pageNum);
      let activeEntry = numberedEntries.find((entry) => isActivePageControl(entry.el));

      // Fallback to URL ?page=N query param if DOM lacks active/current markers
      if (!activeEntry) {
        const params = new URLSearchParams(window.location.search);
        const urlPage = Number.parseInt(params.get('page') || params.get('p') || '', 10);
        if (Number.isFinite(urlPage) && numberedByPage.has(urlPage)) {
          activeEntry = numberedByPage.get(urlPage);
        }
      }

      if (activeEntry) {
        const nextEntry = numberedByPage.get(activeEntry.pageNum + 1);
        if (nextEntry && !isControlDisabled(nextEntry.el)) {
          return {
            status: 'found',
            element: nextEntry.el,
            mode: 'numbered',
            currentPage: activeEntry.pageNum,
            targetPage: nextEntry.pageNum,
            label: `Page ${nextEntry.pageNum}`
          };
        }
        return {
          status: 'end_of_pages',
          currentPage: activeEntry.pageNum
        };
      }
    }

    if (hasDisabledExplicitNext) {
      return { status: 'end_of_pages' };
    }

    return { status: 'none' };
  }

  /**
   * Clicks the next page button, polls up to 5 seconds until the first row's filename
   * changes (confirming SPA render), and scrolls back to the top of the list.
   */
  async function advanceToNextPage(paginationAction, prevFirstFileName, scrollContainer) {
    paginationAction.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await interruptibleSleep(120);
    if (state === 'stopping' || state === 'idle') {
      return { advanced: false, aborted: 'stop' };
    }
    if (state === 'paused') {
      return { advanced: false, aborted: 'pause' };
    }

    paginationAction.element.click();

    const deadline = Date.now() + PAGINATION_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const sleepRes = await interruptibleSleep(PAGINATION_POLL_INTERVAL_MS);
      if (sleepRes === 'stop' || state === 'stopping' || state === 'idle') {
        return { advanced: false, aborted: 'stop' };
      }
      if (sleepRes === 'pause' || state === 'paused') {
        return { advanced: false, aborted: 'pause' };
      }

      const { items: newItems } = findPlayableRows(settings.selectors);
      if (newItems.length > 0) {
        const newFirstFileName = newItems[0].fileName;
        if (newFirstFileName !== prevFirstFileName) {
          // Next page rendered — scroll back to the top of the list before continuing
          if (scrollContainer && scrollContainer !== window && scrollContainer.isConnected) {
            scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
          newItems[0].row.scrollIntoView({ behavior: 'smooth', block: 'center' });

          const settleRes = await interruptibleSleep(300);
          if (settleRes === 'stop' || state === 'stopping' || state === 'idle') {
            return { advanced: false, aborted: 'stop' };
          }
          return { advanced: true, newFirstFileName };
        }
      }
    }

    return { advanced: false, reason: 'timeout' };
  }

  /**
   * Interruptible sleep that wakes immediately on STOP, PAUSE, or SKIP if requested.
   */
  function interruptibleSleep(ms) {
    if (ms <= 0) return Promise.resolve('done');
    return new Promise((resolve) => {
      const entry = {
        resolve: (reason) => {
          clearTimeout(timer);
          sleepAbortResolvers.delete(entry);
          resolve(reason);
        }
      };
      const timer = setTimeout(() => entry.resolve('done'), ms);
      sleepAbortResolvers.add(entry);
    });
  }

  function wakePendingSleeps(reason) {
    for (const entry of Array.from(sleepAbortResolvers)) {
      entry.resolve(reason);
    }
  }

  function waitWhilePaused() {
    if (state !== 'paused') return Promise.resolve();
    return new Promise((resolve) => {
      pauseResumeResolvers.add(resolve);
    });
  }

  function wakePausedWaiters() {
    for (const resolve of Array.from(pauseResumeResolvers)) {
      pauseResumeResolvers.delete(resolve);
      resolve();
    }
  }

  /**
   * Captures a snapshot of a row and play button's playback-related DOM attributes.
   */
  function capturePlaybackSnapshot(row, playBtn) {
    return {
      btnAriaLabel: (playBtn.getAttribute('aria-label') || '').trim(),
      btnTitle: (playBtn.getAttribute('title') || '').trim(),
      btnAriaPressed: playBtn.getAttribute('aria-pressed') || '',
      btnDataState: playBtn.getAttribute('data-state') || playBtn.getAttribute('data-playing') || '',
      btnClass: playBtn.className || '',
      btnHtml: playBtn.innerHTML || '',
      rowClass: row.className || '',
      rowDataState: row.getAttribute('data-state') || row.getAttribute('data-playing') || row.getAttribute('aria-selected') || ''
    };
  }

  function isExplicitlyPlaying(row, playBtn) {
    const label = `${playBtn.getAttribute('aria-label') || ''} ${playBtn.getAttribute('title') || ''}`;
    if (/\b(pause|stop)\b/i.test(label) && !/\bplay\b/i.test(label)) return true;
    if (playBtn.getAttribute('aria-pressed') === 'true') return true;

    const btnState = (playBtn.getAttribute('data-state') || playBtn.getAttribute('data-playing') || '').toLowerCase();
    const rowState = (row.getAttribute('data-state') || row.getAttribute('data-playing') || '').toLowerCase();
    if (btnState === 'playing' || btnState === 'true' || rowState === 'playing' || rowState === 'true') {
      return true;
    }

    const classes = `${playBtn.className || ''} ${row.className || ''}`;
    if (/\b(is-playing|playing|now-playing|audio-playing)\b/i.test(classes)) {
      return true;
    }

    return false;
  }

  function isExplicitlyIdle(row, playBtn) {
    const label = `${playBtn.getAttribute('aria-label') || ''} ${playBtn.getAttribute('title') || ''}`;
    if (/\bplay\b/i.test(label) && !/\b(pause|stop)\b/i.test(label)) return true;
    if (playBtn.getAttribute('aria-pressed') === 'false') return true;

    const btnState = (playBtn.getAttribute('data-state') || playBtn.getAttribute('data-playing') || '').toLowerCase();
    const rowState = (row.getAttribute('data-state') || row.getAttribute('data-playing') || '').toLowerCase();
    if (btnState === 'paused' || btnState === 'idle' || btnState === 'stopped' || btnState === 'false') return true;
    if (rowState === 'paused' || rowState === 'idle' || rowState === 'stopped' || rowState === 'false') return true;

    return false;
  }

  function snapshotChanged(snapA, snapB) {
    return (
      snapA.btnAriaLabel !== snapB.btnAriaLabel ||
      snapA.btnTitle !== snapB.btnTitle ||
      snapA.btnAriaPressed !== snapB.btnAriaPressed ||
      snapA.btnDataState !== snapB.btnDataState ||
      snapA.btnClass !== snapB.btnClass ||
      snapA.btnHtml !== snapB.btnHtml ||
      snapA.rowClass !== snapB.rowClass ||
      snapA.rowDataState !== snapB.rowDataState
    );
  }

  function snapshotMatchesIdle(current, preClick) {
    return (
      current.btnAriaLabel === preClick.btnAriaLabel &&
      current.btnAriaPressed === preClick.btnAriaPressed &&
      current.btnDataState === preClick.btnDataState &&
      current.btnHtml === preClick.btnHtml &&
      current.rowDataState === preClick.rowDataState
    );
  }

  /**
   * Observes the row & play button via MutationObserver (plus native <audio>/<video> ended events)
   * until playback finishes, or until watchdog / user control resolves it.
   */
  function waitForPlaybackCompletion(row, playBtn, preClickSnap, recordingId) {
    return new Promise((resolve) => {
      let settled = false;
      let hasEnteredPlaying = false;
      let idleDebounceTimer = null;
      const mediaCleanup = [];

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        if (idleDebounceTimer) {
          clearTimeout(idleDebounceTimer);
          idleDebounceTimer = null;
        }
        if (activeObserver) {
          activeObserver.disconnect();
          activeObserver = null;
        }
        for (const fn of mediaCleanup) {
          fn();
        }
        if (currentPlaybackResolver === finish) {
          currentPlaybackResolver = null;
        }
        resolve(outcome);
      };

      currentPlaybackResolver = finish;

      const evaluateDomState = () => {
        if (settled) return;
        if (!row.isConnected || !playBtn.isConnected) {
          // Virtualized row detached from DOM; rely on watchdog or finish gracefully
          return;
        }

        const currentSnap = capturePlaybackSnapshot(row, playBtn);

        if (!hasEnteredPlaying) {
          if (isExplicitlyPlaying(row, playBtn) || snapshotChanged(currentSnap, preClickSnap)) {
            hasEnteredPlaying = true;
          }
          return;
        }

        // Already entered playing state: detect return to idle/stopped
        const returnedToIdle =
          (!isExplicitlyPlaying(row, playBtn) && isExplicitlyIdle(row, playBtn)) ||
          (!isExplicitlyPlaying(row, playBtn) && snapshotMatchesIdle(currentSnap, preClickSnap));

        if (returnedToIdle) {
          if (!idleDebounceTimer) {
            idleDebounceTimer = setTimeout(() => {
              if (!settled && !isExplicitlyPlaying(row, playBtn)) {
                finish({ reason: 'dom_ended', recordingId });
              }
            }, 140);
          }
        } else if (idleDebounceTimer) {
          clearTimeout(idleDebounceTimer);
          idleDebounceTimer = null;
        }
      };

      // Attach MutationObserver to row (and playBtn separately if outside row)
      activeObserver = new MutationObserver(() => {
        evaluateDomState();
      });

      const observerConfig = {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true
      };

      activeObserver.observe(row, observerConfig);
      if (!row.contains(playBtn)) {
        activeObserver.observe(playBtn, observerConfig);
      }

      // Also hook native <audio>/<video> elements inside row or actively playing on page
      const mediaEls = new Set([
        ...row.querySelectorAll('audio, video'),
        ...document.querySelectorAll('audio, video')
      ]);

      for (const media of mediaEls) {
        const onPlaying = () => {
          hasEnteredPlaying = true;
        };
        const onEnded = () => {
          if (hasEnteredPlaying) {
            finish({ reason: 'media_ended', recordingId });
          }
        };
        media.addEventListener('playing', onPlaying);
        media.addEventListener('ended', onEnded);
        mediaCleanup.push(() => {
          media.removeEventListener('playing', onPlaying);
          media.removeEventListener('ended', onEnded);
        });
      }

      // Evaluate shortly after click in case state toggled synchronously before observer queued
      setTimeout(evaluateDomState, 60);
    });
  }

  function stopPlaybackIfStillActive(row, playBtn) {
    try {
      if (row && playBtn && playBtn.isConnected && isExplicitlyPlaying(row, playBtn)) {
        playBtn.click();
      }
    } catch (_) {
      // Ignore DOM click errors during teardown
    }
  }

  function sendToBackground(payload) {
    return chrome.runtime.sendMessage({ ...payload, target: 'background' });
  }

  /**
   * Main async sequencer loop.
   */
  async function runSequencerLoop() {
    let lastSeenRow = null;
    let scrollRetries = 0;
    const MAX_SCROLL_RETRIES = 5;
    const SCROLL_RETRY_INTERVAL_MS = 800;

    try {
      await loadProcessedSet();
      const folderName = extractCollectionTitle(settings.selectors);

      while (state === 'running' || state === 'paused') {
        if (state === 'paused') {
          await waitWhilePaused();
          if (state !== 'running') break;
        }

        const { items } = findPlayableRows(settings.selectors);
        for (const item of items) {
          knownItems.add(item.key);
        }

        const nextItem = items.find((item) => !visitedThisRun.has(item.key));

        if (!nextItem) {
          await sendToBackground({
            type: 'SEQUENCER_PROGRESS',
            folderName,
            processedCount: visitedThisRun.size,
            totalCount: knownItems.size,
            currentFile: ''
          });

          if (items.length > 0) {
            lastSeenRow = items[items.length - 1].row;
          }

          // 1. Check numbered / explicit "Next" pagination first
          const paginationAction = findPaginationAction(settings.selectors);

          if (paginationAction.status === 'found') {
            const prevFirstFileName = items[0]?.fileName || '';
            const scrollContainer = findScrollContainer(items[0]?.row || lastSeenRow);
            const pageDetail = paginationAction.mode === 'numbered'
              ? `Advancing pagination: page ${paginationAction.currentPage} → ${paginationAction.targetPage}`
              : `Clicking pagination control: ${paginationAction.label}`;

            await sendToBackground({
              type: 'SEQUENCER_LOG',
              level: 'info',
              detail: pageDetail
            });

            const pageResult = await advanceToNextPage(paginationAction, prevFirstFileName, scrollContainer);
            if (pageResult.aborted === 'stop' || state === 'stopping' || state === 'idle') {
              break;
            }
            if (pageResult.aborted === 'pause' || state === 'paused') {
              continue;
            }

            if (pageResult.advanced) {
              scrollRetries = 0;
              lastSeenRow = null;
              continue;
            }

            // Polling timed out after 5s without first row changing -> complete cleanly
            clearAllHighlights();
            state = 'idle';
            await sendToBackground({
              type: 'SEQUENCER_LOG',
              level: 'info',
              detail: 'Pagination timed out waiting for next page items; completing batch.'
            });
            await sendToBackground({
              type: 'SEQUENCER_COMPLETE',
              folderName,
              processedCount: visitedThisRun.size,
              totalCount: knownItems.size
            });
            return;
          }

          if (paginationAction.status === 'end_of_pages') {
            clearAllHighlights();
            state = 'idle';
            await sendToBackground({
              type: 'SEQUENCER_LOG',
              level: 'info',
              detail: paginationAction.currentPage
                ? `Reached final page (page ${paginationAction.currentPage}).`
                : 'Next page button is disabled; reached final page.'
            });
            await sendToBackground({
              type: 'SEQUENCER_COMPLETE',
              folderName,
              processedCount: visitedThisRun.size,
              totalCount: knownItems.size
            });
            return;
          }

          // 2. Fallback to infinite scroll / Load More retries when no pagination bar is present
          if (scrollRetries >= MAX_SCROLL_RETRIES) {
            clearAllHighlights();
            state = 'idle';
            await sendToBackground({
              type: 'SEQUENCER_COMPLETE',
              folderName,
              processedCount: visitedThisRun.size,
              totalCount: knownItems.size
            });
            return;
          }

          scrollRetries++;

          tryClickLoadMoreButton();

          if (lastSeenRow && lastSeenRow.isConnected) {
            lastSeenRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const scrollContainer = findScrollContainer(lastSeenRow);
            if (scrollContainer === window) {
              window.scrollBy({ top: Math.max(420, Math.round(window.innerHeight * 0.75)), behavior: 'smooth' });
            } else {
              scrollContainer.scrollBy({
                top: Math.max(360, Math.round(scrollContainer.clientHeight * 0.8)),
                behavior: 'smooth'
              });
            }
          } else {
            window.scrollBy({ top: Math.max(420, Math.round(window.innerHeight * 0.75)), behavior: 'smooth' });
          }

          const sleepResult = await interruptibleSleep(SCROLL_RETRY_INTERVAL_MS);
          if (sleepResult === 'stop' || state === 'stopping' || state === 'idle') {
            break;
          }
          continue;
        }

        // Found an item -> reset lazy-load retry counter
        scrollRetries = 0;
        lastSeenRow = nextItem.row;

        // Duplicate protection: check session cache AND physical disk when Skip Existing Files is ON
        if (settings.skipExistingFiles !== false) {
          let alreadyExists = processedSet.has(nextItem.key);
          if (!alreadyExists) {
            const existsRes = await sendToBackground({
              type: 'CHECK_FILE_EXISTS',
              folderName,
              fileName: nextItem.fileName
            });
            if (existsRes && existsRes.ok && existsRes.exists) {
              alreadyExists = true;
            }
          }

          if (state === 'stopping' || state === 'idle') break;
          if (state === 'paused') continue;

          if (alreadyExists) {
            visitedThisRun.add(nextItem.key);
            if (!processedSet.has(nextItem.key)) {
              processedSet.add(nextItem.key);
              await saveProcessedSet();
            }

            await sendToBackground({
              type: 'SEQUENCER_LOG',
              level: 'skip',
              fileName: '',
              detail: `↷ Skipped (already exists): ${nextItem.fileName}`
            });

            await sendToBackground({
              type: 'SEQUENCER_PROGRESS',
              folderName,
              processedCount: visitedThisRun.size,
              totalCount: knownItems.size,
              currentFile: '',
              incrementSkipped: true
            });
            continue;
          }
        }

        await sendToBackground({
          type: 'SEQUENCER_PROGRESS',
          folderName,
          processedCount: visitedThisRun.size,
          totalCount: knownItems.size,
          currentFile: nextItem.fileName
        });

        // 1. Scroll target row to center and highlight
        nextItem.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setRowHighlight(nextItem.row);

        const settleRes = await interruptibleSleep(220);
        if (settleRes === 'stop' || state === 'stopping' || state === 'idle') {
          removeRowHighlight(nextItem.row);
          break;
        }
        if (settleRes === 'pause' || state === 'paused') {
          removeRowHighlight(nextItem.row);
          continue;
        }

        // 2. Request START_RECORDING from background and await RECORDING_READY
        const startRes = await sendToBackground({
          type: 'START_RECORDING',
          folderName,
          fileName: nextItem.fileName,
          processedCount: visitedThisRun.size,
          totalCount: knownItems.size
        });

        if (!startRes || !startRes.ok || startRes.type !== 'RECORDING_READY') {
          throw new Error(startRes?.error || 'Background failed to arm recording.');
        }

        currentRecordingId = startRes.recordingId;

        // 3. Snapshot pre-click DOM state and click Play
        const preClickSnap = capturePlaybackSnapshot(nextItem.row, nextItem.playBtn);
        const playbackPromise = waitForPlaybackCompletion(
          nextItem.row,
          nextItem.playBtn,
          preClickSnap,
          currentRecordingId
        );

        nextItem.playBtn.click();

        // 4. Wait for playback completion (MutationObserver, <audio> ended, Watchdog, or Control)
        const outcome = await playbackPromise;
        const completedRecordingId = currentRecordingId;
        currentRecordingId = null;

        if (outcome.reason === 'stop' || state === 'stopping' || state === 'idle') {
          stopPlaybackIfStillActive(nextItem.row, nextItem.playBtn);
          await sendToBackground({
            type: 'DISCARD_RECORDING',
            reason: 'stop',
            fileName: nextItem.fileName,
            processedCount: visitedThisRun.size,
            totalCount: knownItems.size
          });
          removeRowHighlight(nextItem.row);
          break;
        }

        if (outcome.reason === 'pause' || state === 'paused') {
          stopPlaybackIfStillActive(nextItem.row, nextItem.playBtn);
          await sendToBackground({
            type: 'DISCARD_RECORDING',
            reason: 'pause',
            fileName: nextItem.fileName,
            processedCount: visitedThisRun.size,
            totalCount: knownItems.size
          });
          removeRowHighlight(nextItem.row);
          // Do NOT mark visited/processed so Resume cleanly records this item from the start
          continue;
        }

        if (outcome.reason === 'skip') {
          stopPlaybackIfStillActive(nextItem.row, nextItem.playBtn);
          visitedThisRun.add(nextItem.key);
          processedSet.add(nextItem.key);
          await saveProcessedSet();
          await sendToBackground({
            type: 'DISCARD_RECORDING',
            reason: 'skip',
            fileName: nextItem.fileName,
            processedCount: visitedThisRun.size,
            totalCount: knownItems.size
          });
          removeRowHighlight(nextItem.row);
          await interruptibleSleep(250);
          continue;
        }

        // If stopped by 40s max-duration watchdog, pause the item so it doesn't bleed into the next take
        if (outcome.reason === 'watchdog_max_duration') {
          stopPlaybackIfStillActive(nextItem.row, nextItem.playBtn);
        }

        // 5. Wait configurable Tail Buffer (skip extra wait if 1.5s silence watchdog already captured tail)
        if (outcome.reason !== 'watchdog_silence') {
          const tailMs = Math.max(0, Number(settings.tailBufferMs) || 0);
          if (tailMs > 0) {
            const tailRes = await interruptibleSleep(tailMs);
            if (tailRes === 'stop' || state === 'stopping' || state === 'idle') {
              await sendToBackground({ type: 'DISCARD_RECORDING', reason: 'stop', fileName: nextItem.fileName });
              removeRowHighlight(nextItem.row);
              break;
            }
          }
        }

        // 6. Send STOP_AND_SAVE and await SAVED_OK
        const wasAlreadyCached = processedSet.has(nextItem.key);
        visitedThisRun.add(nextItem.key);
        processedSet.add(nextItem.key);
        const saveRes = await sendToBackground({
          type: 'STOP_AND_SAVE',
          recordingId: completedRecordingId,
          folderName,
          fileName: nextItem.fileName,
          processedCount: visitedThisRun.size,
          totalCount: knownItems.size
        });

        if (!saveRes || !saveRes.ok || saveRes.type !== 'SAVED_OK') {
          visitedThisRun.delete(nextItem.key);
          if (!wasAlreadyCached) processedSet.delete(nextItem.key);
          throw new Error(saveRes?.error || `Failed to save ${nextItem.fileName}`);
        }

        await saveProcessedSet();

        // 7. Remove highlight and wait Interval Delay + 0–300ms random DOM-settling variance
        removeRowHighlight(nextItem.row);

        const baseInterval = Math.max(50, Number(settings.intervalDelayMs) || 500);
        const varianceMs = Math.floor(Math.random() * 301);
        const waitRes = await interruptibleSleep(baseInterval + varianceMs);
        if (waitRes === 'stop' || state === 'stopping' || state === 'idle') {
          break;
        }
      }
    } catch (err) {
      cleanupAllResources();
      state = 'idle';
      await sendToBackground({
        type: 'SEQUENCER_ERROR',
        error: err?.message || String(err)
      }).catch(() => {});
      return;
    }

    cleanupAllResources();
    state = 'idle';
  }

  function cleanupAllResources() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    currentRecordingId = null;
    currentPlaybackResolver = null;
    clearAllHighlights();
  }

  /**
   * Highlights matched rows for preview and reports count + sample names.
   */
  function handleTestSelectors(customSelectors) {
    clearAllHighlights();
    ensureStylesInjected();

    const mergedSelectors = {
      ...DEFAULT_SETTINGS.selectors,
      ...(customSelectors || {})
    };

    const collectionTitle = extractCollectionTitle(mergedSelectors);
    const { items, totalRawRows } = findPlayableRows(mergedSelectors);
    const pagination = findPaginationAction(mergedSelectors);

    for (const item of items) {
      item.row.classList.add(TEST_HIGHLIGHT_CLASS);
    }

    if (pagination.status === 'found' && pagination.element) {
      pagination.element.classList.add(TEST_HIGHLIGHT_CLASS);
    }

    if (items.length > 0) {
      const firstRect = items[0].row.getBoundingClientRect();
      const inView = firstRect.top >= 0 && firstRect.bottom <= window.innerHeight;
      if (!inView) {
        items[0].row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    testHighlightTimer = setTimeout(() => {
      document.querySelectorAll(`.${TEST_HIGHLIGHT_CLASS}`).forEach((el) => {
        el.classList.remove(TEST_HIGHLIGHT_CLASS);
      });
      testHighlightTimer = null;
    }, 4500);

    return {
      ok: true,
      count: items.length,
      totalRawRows,
      collectionTitle,
      sampleNames: items.slice(0, 5).map((i) => i.fileName),
      pagination: {
        status: pagination.status,
        mode: pagination.mode || null,
        label: pagination.label || null,
        currentPage: pagination.currentPage || null,
        targetPage: pagination.targetPage || null
      }
    };
  }

  // Message Listener from background.js
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    try {
      switch (message.type) {
        case 'PING_CONTENT':
          sendResponse({ ok: true, state });
          return false;

        case 'SEQUENCER_TEST_SELECTORS':
          sendResponse(handleTestSelectors(message.selectors));
          return false;

        case 'SEQUENCER_UPDATE_SETTINGS':
          if (message.settings) {
            settings = {
              ...settings,
              ...message.settings,
              selectors: {
                ...settings.selectors,
                ...(message.settings.selectors || {})
              }
            };
          }
          sendResponse({ ok: true });
          return false;

        case 'SEQUENCER_START': {
          if (message.settings) {
            settings = {
              ...DEFAULT_SETTINGS,
              ...message.settings,
              selectors: {
                ...DEFAULT_SETTINGS.selectors,
                ...(message.settings.selectors || {})
              }
            };
          }

          // Validate selectors upfront before starting async loop
          extractCollectionTitle(settings.selectors);
          findPaginationAction(settings.selectors);
          const preview = findPlayableRows(settings.selectors);
          if (preview.items.length === 0) {
            sendResponse({
              ok: false,
              error: 'No playable rows matched the configured selectors on this page. Use "Test Selectors" to verify.'
            });
            return false;
          }

          state = 'running';
          runSequencerLoop();
          sendResponse({ ok: true, initialCount: preview.items.length });
          return false;
        }

        case 'SEQUENCER_PAUSE':
          if (state === 'running') {
            state = 'paused';
            wakePendingSleeps('pause');
            if (currentPlaybackResolver) {
              currentPlaybackResolver({ reason: 'pause' });
            }
          }
          sendResponse({ ok: true });
          return false;

        case 'SEQUENCER_RESUME':
          if (message.settings) {
            settings = {
              ...settings,
              ...message.settings,
              selectors: {
                ...settings.selectors,
                ...(message.settings.selectors || {})
              }
            };
          }
          if (state === 'paused') {
            state = 'running';
            wakePausedWaiters();
          }
          sendResponse({ ok: true });
          return false;

        case 'SEQUENCER_SKIP':
          if (state === 'running') {
            wakePendingSleeps('skip');
            if (currentPlaybackResolver) {
              currentPlaybackResolver({ reason: 'skip' });
            }
          }
          sendResponse({ ok: true });
          return false;

        case 'SEQUENCER_STOP':
          state = 'stopping';
          wakePendingSleeps('stop');
          wakePausedWaiters();
          if (currentPlaybackResolver) {
            currentPlaybackResolver({ reason: 'stop' });
          }
          cleanupAllResources();
          state = 'idle';
          sendResponse({ ok: true });
          return false;

        case 'SEQUENCER_WATCHDOG_STOP':
          if (
            state === 'running' &&
            currentPlaybackResolver &&
            (!message.recordingId || message.recordingId === currentRecordingId)
          ) {
            const reason = message.reason === 'max_duration' ? 'watchdog_max_duration' : 'watchdog_silence';
            currentPlaybackResolver({ reason, recordingId: message.recordingId });
          }
          sendResponse({ ok: true });
          return false;

        case 'SEQUENCER_CLEAR_CACHE':
          processedSet.clear();
          visitedThisRun.clear();
          knownItems.clear();
          sendResponse({ ok: true });
          return false;

        default:
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
      return false;
    }
  });

  window.addEventListener('beforeunload', () => {
    cleanupAllResources();
  });
})();
