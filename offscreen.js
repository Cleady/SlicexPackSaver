/**
 * offscreen.js
 * Offscreen document host for Tab Audio Capture (Web Audio API + AudioWorkletNode),
 * real-time onset/silence watchdog, DSP auto-trimming, and 16-bit Stereo RIFF WAVE encoding.
 */

'use strict';

// DSP & Watchdog Constants
const LEADING_SILENCE_THRESHOLD = 0.001;                  // ~ -60 dBFS
const LEADING_PREROLL_SEC = 0.005;                        // 5ms transient pre-roll
const TRAILING_SILENCE_THRESHOLD = Math.pow(10, -65 / 20); // -65 dBFS (~0.00056234)
const TRAILING_KEEP_SEC = 0.150;                          // 150ms natural tail
const ONSET_THRESHOLD = Math.pow(10, -55 / 20);           // -55 dBFS (~0.00177828)
const WATCHDOG_SILENCE_THRESHOLD = 0.001;                 // -60 dBFS
const WATCHDOG_SILENCE_SEC = 1.5;                         // 1.5s continuous silence after onset
const WATCHDOG_MAX_DURATION_SEC = 40.0;                   // 40s hard safety cap
const KEEPALIVE_INTERVAL_MS = 20000;                      // 20s ping to keep MV3 SW alive

// Audio Graph State
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let monitorGain = null;
let silentSinkGain = null;
let isSilentMode = false;
let defaultAutoTrimLeading = true;

// Active Recording Buffer State
let isRecording = false;
let isFlushing = false;
let activeRecordingId = null;
let pendingFlushResolver = null;
let leftChunks = [];
let rightChunks = [];
let totalFrames = 0;
let hasOnset = false;
let consecutiveSilentFrames = 0;
let watchdogFired = false;
let recordingPeak = 0;

// Blob URL Lifecycle Tracking
const activeBlobUrls = new Map(); // blobUrl -> timeoutId

// Service Worker Keepalive Port
let keepalivePort = null;
let keepaliveTimer = null;

function connectKeepalivePort() {
  if (keepalivePort) {
    try {
      keepalivePort.disconnect();
    } catch (_) {
      // Ignore already disconnected port
    }
    keepalivePort = null;
  }

  try {
    keepalivePort = chrome.runtime.connect({ name: 'offscreen-keepalive' });
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
      // Reconnect after a brief delay while offscreen document remains alive
      setTimeout(() => {
        if (!keepalivePort) {
          connectKeepalivePort();
        }
      }, 1500);
    });
  } catch (_) {
    // Extension may be unloading
  }
}

function startKeepalive() {
  connectKeepalivePort();
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    if (!keepalivePort) {
      connectKeepalivePort();
    }
    if (keepalivePort) {
      try {
        keepalivePort.postMessage({ type: 'PING', ts: Date.now() });
      } catch (_) {
        connectKeepalivePort();
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
}

startKeepalive();

/**
 * Flattens an array of Float32Array chunks into a single contiguous Float32Array.
 *
 * @param {Float32Array[]} chunks
 * @returns {Float32Array}
 */
function flattenFloat32Chunks(chunks) {
  let totalLength = 0;
  for (let i = 0; i < chunks.length; i++) {
    totalLength += chunks[i].length;
  }
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * Pure JavaScript 16-bit Stereo RIFF WAVE Encoder.
 * Writes a standard 44-byte RIFF/WAVE header followed by strictly clamped
 * interleaved Int16 PCM samples.
 *
 * @param {Float32Array[]} leftChannelChunks
 * @param {Float32Array[]} rightChannelChunks
 * @param {number} sampleRate
 * @returns {Blob}
 */
function encodeWAV(leftChannelChunks, rightChannelChunks, sampleRate) {
  const leftMerged = flattenFloat32Chunks(leftChannelChunks);
  const rightMerged = flattenFloat32Chunks(rightChannelChunks);
  const totalLength = Math.min(leftMerged.length, rightMerged.length);

  const numChannels = 2;
  const bitsPerSample = 16;
  const blockAlign = 4;               // 2 channels * 2 bytes/sample
  const byteRate = sampleRate * 2 * 2; // sampleRate * numChannels * bytesPerSample
  const dataByteLength = totalLength * blockAlign;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAsciiString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);            // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);             // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);   // NumChannels (2 = Stereo)
  view.setUint32(24, sampleRate, true);    // SampleRate (live AudioContext sampleRate)
  view.setUint32(28, byteRate, true);      // ByteRate (sampleRate * 2 * 2)
  view.setUint16(32, blockAlign, true);    // BlockAlign (4)
  view.setUint16(34, bitsPerSample, true); // BitsPerSample (16)

  // data sub-chunk
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  // Interleaved Int16 PCM payload with strict [-1, 1] clamping
  let offset = 44;
  for (let i = 0; i < totalLength; i++) {
    const rawL = leftMerged[i];
    const sL = Number.isFinite(rawL) ? Math.max(-1, Math.min(1, rawL)) : 0;
    const intL = sL < 0 ? Math.round(sL * 0x8000) : Math.round(sL * 0x7FFF);
    view.setInt16(offset, intL, true);
    offset += 2;

    const rawR = rightMerged[i];
    const sR = Number.isFinite(rawR) ? Math.max(-1, Math.min(1, rawR)) : 0;
    const intR = sR < 0 ? Math.round(sR * 0x8000) : Math.round(sR * 0x7FFF);
    view.setInt16(offset, intR, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Performs synchronized DSP auto-trimming of leading and trailing silence,
 * applying the exact same startIndex and endIndex to both Left and Right channels.
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sampleRate
 * @param {boolean} autoTrimLeading
 */
function dspTrimAudio(left, right, sampleRate, autoTrimLeading) {
  const total = Math.min(left.length, right.length);
  if (total === 0) {
    const fallbackFrames = Math.max(1, Math.round(0.05 * sampleRate));
    return {
      left: new Float32Array(fallbackFrames),
      right: new Float32Array(fallbackFrames),
      trimmedLeadingMs: 0,
      trimmedTrailingMs: 0,
      silentWarning: true
    };
  }

  let startIndex = 0;
  let endIndex = total;
  let silentWarning = false;

  // 1. Auto-Trim Leading Silence (> 0.001 ~ -60 dBFS, step back 5ms pre-roll)
  if (autoTrimLeading) {
    let firstActive = -1;
    for (let i = 0; i < total; i++) {
      const aL = left[i] < 0 ? -left[i] : left[i];
      const aR = right[i] < 0 ? -right[i] : right[i];
      if ((aL > aR ? aL : aR) > LEADING_SILENCE_THRESHOLD) {
        firstActive = i;
        break;
      }
    }

    if (firstActive !== -1) {
      const preRollSamples = Math.round(LEADING_PREROLL_SEC * sampleRate);
      startIndex = Math.max(0, firstActive - preRollSamples);
    } else {
      silentWarning = true;
    }
  }

  // 2. Auto-Trim Trailing Silence (keep 150ms past last sample > -65 dBFS)
  let lastActive = -1;
  for (let i = total - 1; i >= startIndex; i--) {
    const aL = left[i] < 0 ? -left[i] : left[i];
    const aR = right[i] < 0 ? -right[i] : right[i];
    if ((aL > aR ? aL : aR) > TRAILING_SILENCE_THRESHOLD) {
      lastActive = i;
      break;
    }
  }

  if (lastActive !== -1) {
    const tailKeepSamples = Math.round(TRAILING_KEEP_SEC * sampleRate);
    endIndex = Math.min(total, lastActive + 1 + tailKeepSamples);
    silentWarning = false;
  } else {
    // Entire captured buffer is below -65 dBFS; keep a short valid WAV slice and flag warning
    silentWarning = true;
    startIndex = 0;
    endIndex = Math.min(total, Math.round(0.5 * sampleRate));
  }

  if (endIndex <= startIndex) {
    endIndex = Math.min(total, startIndex + Math.max(1, Math.round(0.05 * sampleRate)));
  }

  const trimmedLeadingMs = Math.round((startIndex / sampleRate) * 1000);
  const trimmedTrailingMs = Math.round(((total - endIndex) / sampleRate) * 1000);

  // Slice both channels with identical [startIndex, endIndex) bounds
  return {
    left: left.subarray(startIndex, endIndex),
    right: right.subarray(startIndex, endIndex),
    trimmedLeadingMs,
    trimmedTrailingMs,
    silentWarning
  };
}

function resetBuffers() {
  leftChunks = [];
  rightChunks = [];
  totalFrames = 0;
  hasOnset = false;
  consecutiveSilentFrames = 0;
  watchdogFired = false;
  recordingPeak = 0;
}

function handlePcmChunk(data) {
  if ((!isRecording && !isFlushing) || !audioContext) return;
  if (data.recordingId && activeRecordingId && data.recordingId !== activeRecordingId) {
    return;
  }

  const { left, right, peak } = data;
  if (!left || !right) return;

  const safeLen = Math.min(left.length, right.length);
  if (safeLen === 0) return;

  const leftSlice = left.length === safeLen ? left : left.subarray(0, safeLen);
  const rightSlice = right.length === safeLen ? right : right.subarray(0, safeLen);

  leftChunks.push(leftSlice);
  rightChunks.push(rightSlice);
  totalFrames += safeLen;
  if (peak > recordingPeak) {
    recordingPeak = peak;
  }

  // Only run real-time watchdog while actively recording (skip during final STOP flush)
  if (!isRecording) return;

  const sampleRate = audioContext.sampleRate;

  // Onset & Continuous Silence Watchdog
  if (!hasOnset) {
    if (peak > ONSET_THRESHOLD) {
      hasOnset = true;
      consecutiveSilentFrames = 0;
    }
  } else {
    if (peak <= WATCHDOG_SILENCE_THRESHOLD) {
      consecutiveSilentFrames += safeLen;
    } else {
      consecutiveSilentFrames = 0;
    }
  }

  if (!watchdogFired) {
    const silenceSec = consecutiveSilentFrames / sampleRate;
    const totalSec = totalFrames / sampleRate;

    if (hasOnset && silenceSec >= WATCHDOG_SILENCE_SEC) {
      watchdogFired = true;
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'WATCHDOG_TRIGGER',
        recordingId: activeRecordingId,
        reason: 'silence',
        silenceSec,
        totalSec
      }).catch(() => {});
    } else if (totalSec >= WATCHDOG_MAX_DURATION_SEC) {
      watchdogFired = true;
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'WATCHDOG_TRIGGER',
        recordingId: activeRecordingId,
        reason: 'max_duration',
        totalSec
      }).catch(() => {});
    }
  }
}

/**
 * Initializes the tab audio MediaStream and Web Audio AudioWorklet graph.
 */
async function initCapture({ streamId, silentMode = false, autoTrimLeading = true }) {
  await teardownCapture({ preservePendingBlobs: true });

  isSilentMode = Boolean(silentMode);
  defaultAutoTrimLeading = Boolean(autoTrimLeading);

  if (!streamId) {
    throw new Error('Missing tab capture streamId.');
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const audioTracks = mediaStream.getAudioTracks();
  if (audioTracks.length === 0) {
    await teardownCapture({ preservePendingBlobs: true });
    throw new Error('Captured MediaStream contains no audio tracks.');
  }

  audioTracks[0].addEventListener('ended', () => {
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'CAPTURE_STREAM_ENDED'
    }).catch(() => {});
  });

  // Use native OS/tab sample rate (no hardcoded 44100Hz) to avoid Chromium resampling glitches.
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const workletUrl = chrome.runtime.getURL('pcm-processor.js');
  await audioContext.audioWorklet.addModule(workletUrl);

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });

  workletNode.port.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'PCM_CHUNK') {
      handlePcmChunk(msg);
    } else if (msg.type === 'STOPPED') {
      if (pendingFlushResolver) {
        const resolve = pendingFlushResolver;
        pendingFlushResolver = null;
        resolve(msg.recordingId);
      }
    }
  };

  // Silent sink keeps Chromium pulling AudioWorkletNode render quanta even when monitor is muted.
  silentSinkGain = audioContext.createGain();
  silentSinkGain.gain.value = 0;

  // Passthrough monitor gain (1 = audible live monitoring, 0 = Silent Mode).
  monitorGain = audioContext.createGain();
  monitorGain.gain.value = isSilentMode ? 0 : 1;

  sourceNode.connect(workletNode);
  workletNode.connect(silentSinkGain);
  silentSinkGain.connect(audioContext.destination);

  sourceNode.connect(monitorGain);
  monitorGain.connect(audioContext.destination);

  return {
    ok: true,
    sampleRate: audioContext.sampleRate
  };
}

/**
 * Updates live monitor gain and default DSP settings without interrupting capture.
 */
function updateAudioSettings({ silentMode, autoTrimLeading }) {
  if (typeof silentMode === 'boolean') {
    isSilentMode = silentMode;
    if (monitorGain && audioContext && audioContext.state !== 'closed') {
      const targetGain = isSilentMode ? 0 : 1;
      monitorGain.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.015);
    }
  }
  if (typeof autoTrimLeading === 'boolean') {
    defaultAutoTrimLeading = autoTrimLeading;
  }
  return { ok: true };
}

function resolvePendingFlush() {
  if (pendingFlushResolver) {
    const resolve = pendingFlushResolver;
    pendingFlushResolver = null;
    resolve();
  }
}

/**
 * Begins buffering raw stereo PCM for a single item.
 */
async function startItemRecording({ recordingId, autoTrimLeading }) {
  if (!audioContext || !workletNode || !mediaStream) {
    throw new Error('Audio capture graph is not initialized.');
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  if (typeof autoTrimLeading === 'boolean') {
    defaultAutoTrimLeading = autoTrimLeading;
  }

  // Ensure any prior capture state is completely cleared before starting
  resolvePendingFlush();
  isFlushing = false;
  resetBuffers();
  activeRecordingId = recordingId;
  isRecording = true;
  workletNode.port.postMessage({ type: 'START', recordingId });

  return {
    ok: true,
    recordingId,
    sampleRate: audioContext.sampleRate
  };
}

/**
 * Stops capturing the current item, waits for the AudioWorkletProcessor to flush
 * any remaining partial buffer, applies synchronized stereo DSP trimming,
 * encodes a 16-bit Stereo RIFF WAVE Blob at the live sampleRate, and returns its Object URL.
 */
async function stopAndEncode({ recordingId, autoTrimLeading }) {
  if (!audioContext || !workletNode) {
    throw new Error('Audio capture graph is not active.');
  }

  const targetRecordingId = recordingId || activeRecordingId;

  // Keep accepting incoming chunks while the AudioWorklet flushes its final partial buffer
  isRecording = false;
  isFlushing = true;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      if (pendingFlushResolver === done) {
        pendingFlushResolver = null;
      }
      resolve();
    };
    const safetyTimer = setTimeout(done, 500);
    pendingFlushResolver = done;
    workletNode.port.postMessage({ type: 'STOP', recordingId: targetRecordingId, flush: true });
  });

  isFlushing = false;

  const sampleRate = audioContext.sampleRate;
  const peakAmplitude = recordingPeak;
  const useAutoTrim = typeof autoTrimLeading === 'boolean' ? autoTrimLeading : defaultAutoTrimLeading;

  // Flatten Left & Right chunks independently and enforce strict equal length
  const mergedLeft = flattenFloat32Chunks(leftChunks);
  const mergedRight = flattenFloat32Chunks(rightChunks);
  const totalLength = Math.min(mergedLeft.length, mergedRight.length);

  // Immediately release raw chunk references before encoding
  resetBuffers();
  activeRecordingId = null;

  const syncedLeft = mergedLeft.length === totalLength ? mergedLeft : mergedLeft.subarray(0, totalLength);
  const syncedRight = mergedRight.length === totalLength ? mergedRight : mergedRight.subarray(0, totalLength);

  const trimmed = dspTrimAudio(syncedLeft, syncedRight, sampleRate, useAutoTrim);
  const wavBlob = encodeWAV([trimmed.left], [trimmed.right], sampleRate);

  const blobUrl = URL.createObjectURL(wavBlob);
  // Safety timer ensures no Blob URL can ever leak if a download notification is missed.
  const cleanupTimer = setTimeout(() => {
    revokeBlobUrl(blobUrl);
  }, 120000);
  activeBlobUrls.set(blobUrl, cleanupTimer);

  const durationSec = trimmed.left.length / sampleRate;
  const rawDurationSec = totalLength / sampleRate;
  const peakDb = peakAmplitude > 0 ? 20 * Math.log10(peakAmplitude) : -Infinity;

  return {
    ok: true,
    recordingId: targetRecordingId,
    blobUrl,
    durationSec,
    rawDurationSec,
    trimmedLeadingMs: trimmed.trimmedLeadingMs,
    trimmedTrailingMs: trimmed.trimmedTrailingMs,
    sampleRate,
    byteLength: wavBlob.size,
    peakDb: Number.isFinite(peakDb) ? Number(peakDb.toFixed(1)) : -100,
    silentWarning: trimmed.silentWarning
  };
}

/**
 * Discards the current in-progress recording buffers without encoding.
 */
function discardItemRecording() {
  isRecording = false;
  isFlushing = false;
  resolvePendingFlush();
  const prevId = activeRecordingId;
  activeRecordingId = null;
  if (workletNode) {
    try {
      workletNode.port.postMessage({ type: 'STOP', recordingId: prevId, flush: false });
    } catch (_) {
      // Ignore if node already closed
    }
  }
  resetBuffers();
  return { ok: true };
}

function revokeBlobUrl(blobUrl) {
  if (!blobUrl) return { ok: true };
  const timer = activeBlobUrls.get(blobUrl);
  if (timer) {
    clearTimeout(timer);
    activeBlobUrls.delete(blobUrl);
  }
  try {
    URL.revokeObjectURL(blobUrl);
  } catch (_) {
    // Already revoked
  }
  return { ok: true };
}

function revokeAllBlobUrls() {
  for (const [url, timer] of activeBlobUrls.entries()) {
    clearTimeout(timer);
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      // Ignore
    }
  }
  activeBlobUrls.clear();
}

/**
 * Cleanly tears down all MediaStream tracks, AudioNodes, AudioContext, and buffers.
 */
async function teardownCapture({ preservePendingBlobs = false } = {}) {
  isRecording = false;
  isFlushing = false;
  resolvePendingFlush();
  activeRecordingId = null;
  resetBuffers();

  if (workletNode) {
    try {
      workletNode.port.postMessage({ type: 'STOP', flush: false });
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    } catch (_) {}
    workletNode = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_) {}
    sourceNode = null;
  }

  if (monitorGain) {
    try {
      monitorGain.disconnect();
    } catch (_) {}
    monitorGain = null;
  }

  if (silentSinkGain) {
    try {
      silentSinkGain.disconnect();
    } catch (_) {}
    silentSinkGain = null;
  }

  if (audioContext) {
    try {
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    } catch (_) {}
    audioContext = null;
  }

  if (mediaStream) {
    try {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
    } catch (_) {}
    mediaStream = null;
  }

  if (!preservePendingBlobs) {
    revokeAllBlobUrls();
  }

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'INIT_CAPTURE':
          sendResponse(await initCapture(message));
          break;
        case 'UPDATE_AUDIO_SETTINGS':
          sendResponse(updateAudioSettings(message));
          break;
        case 'START_ITEM_RECORDING':
          sendResponse(await startItemRecording(message));
          break;
        case 'STOP_AND_ENCODE':
          sendResponse(await stopAndEncode(message));
          break;
        case 'DISCARD_ITEM_RECORDING':
          sendResponse(discardItemRecording());
          break;
        case 'REVOKE_BLOB_URL':
          sendResponse(revokeBlobUrl(message.blobUrl));
          break;
        case 'TEARDOWN_CAPTURE':
          sendResponse(await teardownCapture({ preservePendingBlobs: Boolean(message.preservePendingBlobs) }));
          break;
        case 'OFFSCREEN_PING':
          sendResponse({
            ok: true,
            captureReady: Boolean(audioContext && workletNode && mediaStream),
            isRecording,
            pendingBlobs: activeBlobUrls.size
          });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown offscreen message: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

window.addEventListener('unload', () => {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  revokeAllBlobUrls();
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }
});
