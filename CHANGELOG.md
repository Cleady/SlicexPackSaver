# Changelog

All notable changes to **SlicexPackSaver (Tab Audio Batch Recorder)** are documented here.

## [1.0.0] - 2026-11-27

### Added
- Manifest V3 Chrome Extension architecture (`background.js`, `offscreen.html`/`offscreen.js`, `pcm-processor.js`, `content.js`, `popup.html`/`popup.css`/`popup.js`).
- Lossless 16-bit Stereo PCM RIFF WAVE capture using `AudioWorkletNode` with pre-allocated 4096-sample internal buffers, mono-to-stereo safety, and deterministic FIFO `STOP` tail flush.
- Synchronized stereo DSP leading silence auto-trim (`-60 dBFS`, `5 ms` pre-roll), trailing silence auto-trim (`-65 dBFS`, `150 ms` tail), and `-55 dBFS` onset / `1.5 s` silence / `40 s` max-duration watchdog.
- Real-time Silent Mode monitor passthrough toggle (`GainNode`).
- Configurable DOM batch sequencer with **Test Selectors**, explicit Next & numbered pagination (`< 1 2 3 4 >`) + 5-second SPA render polling, and infinite-scroll / Load More fallback.
- Dual duplicate protection (**Skip Existing Files**) checking both unified per-collection `chrome.storage.local` cache and physical disk downloads via `chrome.downloads.search`, plus clean `overwrite` mode when disabled.
- Dark-mode DAW-inspired popup UI with live status card, transport controls, activity log, and automatic GitHub Release update checker.
- GitHub Actions CI validation, automatic extension `.zip` release publishing, and Dependabot maintenance.
