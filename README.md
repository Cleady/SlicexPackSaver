# SlicexPackSaver (Tab Audio Batch Recorder)

A production-ready **Chrome Extension (Manifest V3)** for web audio developers, sound designers, and QA engineers. Records lossless **16-bit Stereo PCM `.wav`** audio directly from the active browser tab using the Web Audio API (`AudioWorkletNode`), automatically trims leading/trailing silence, and automates playback across paginated or infinite-scroll audio lists.

---

## Features

- **True 16-bit Stereo PCM WAV Capture (`AudioWorkletNode`)**
  - Captures raw stereo `Float32` samples directly from the tab audio stream (`chrome.tabCapture`) without `MediaRecorder` / WebM lossy compression.
  - Pre-allocated **4096-sample** internal worklet ring-style accumulation buffers eliminate IPC congestion, dropped frames, and audio crackles.
  - Runs at the OS/tab **native sample rate** (e.g. 48 kHz) with explicit 2-channel speaker routing and strict `[-1.0, 1.0]` Int16 clamping.
- **Real-Time DSP Auto-Trim & Safety Watchdog**
  - **Auto-Trim Leading Silence** (toggleable, default ON): detects signal above `-60 dBFS` (`0.001`) and steps back `5 ms` pre-roll to preserve sharp drum transients.
  - **Auto-Trim Trailing Silence**: retains `150 ms` of natural tail after the last sample above `-65 dBFS`.
  - **Safety Watchdog**: once onset exceeds `-55 dBFS`, automatically finalizes the recording after `1.5 s` of continuous silence or at a `40 s` hard cap.
- **Silent Mode (Live Monitor Toggle)**
  - Toggle live audio monitoring (`gain = 1`) or silent background recording (`gain = 0`) in real time with click-free gain ramping.
- **Configurable DOM Sequencer (Pagination + Infinite Scroll)**
  - Customizable CSS selectors for **Collection Title**, **Row**, **Item Name**, **Play Button**, and **Next Page / Pagination**, with a one-click **Test Selectors** highlighter.
  - Supports explicit **Next** buttons, numbered pagination bars (`< 1 2 3 4 >`) with 5-second SPA render detection, and virtualized/infinite-scroll lists (`Load More` + smooth scroll retries).
  - Full transport controls: **Start Batch**, **Pause / Resume**, **Skip**, **Stop**, and **Clear Cache**.
- **Dual Duplicate Protection**
  - **Skip Existing Files** (default ON) checks both the unified per-collection `chrome.storage.local` cache (normalized across `?page=` params) and physical files on disk via `chrome.downloads.search`.
  - Toggle **Skip Existing Files** OFF to cleanly overwrite existing files (`conflictAction: 'overwrite'`) without `(1).wav` duplicates.
- **GitHub Auto-Release & Update Checker**
  - GitHub Actions automatically validates code and packages `SlicexPackSaver-vX.Y.Z.zip` into **GitHub Releases** whenever `manifest.json` version is bumped.
  - Built-in non-intrusive popup badge notifies you when a newer release is available on GitHub.

---

## Installation

### Option 1: Download Pre-Packaged Release (Recommended)
1. Go to the [Releases](https://github.com/Cleady/SlicexPackSaver/releases) page and download the latest `SlicexPackSaver-v*.zip`.
2. Extract the archive to a permanent folder on your machine.
3. Open `chrome://extensions` in Google Chrome and enable **Developer mode** (top right).
4. Click **Load unpacked** and select the extracted folder.

### Option 2: Clone from Source
```bash
git clone https://github.com/Cleady/SlicexPackSaver.git
```
Load the cloned folder directly via `chrome://extensions` → **Developer mode** → **Load unpacked**.

---

## Quick Usage

1. Open any local test page or web sound library containing playable audio rows.
2. Click the **Tab Audio Batch Recorder** icon in the Chrome toolbar.
3. *(Optional)* Expand **Target Selectors**, adjust CSS selectors for your page, and click **Test Selectors** to highlight matched rows and verify pagination detection.
4. Configure recording options:
   - **Silent Mode**: mute tab passthrough audio while capturing.
   - **Auto-Trim Leading Silence**: trim silence before the first transient (`5 ms` pre-roll).
   - **Skip Existing Files**: skip items already cached or present in `Downloads/Recorded_Sessions/<Folder>/`.
   - **Tail Buffer (ms)** & **Interval Delay (ms)**: fine-tune post-playback tail capture and DOM settling delay.
5. Click **Start Batch**. Recorded files are saved automatically to:
   ```text
   Downloads/Recorded_Sessions/<Sanitized_Collection_Folder>/<Sanitized_Item_Name>.wav
   ```

---

## Project Architecture

| File | Role |
| :--- | :--- |
| `manifest.json` | Manifest V3 permissions (`tabCapture`, `activeTab`, `offscreen`, `downloads`, `storage`, `scripting`) and extension entrypoints |
| `background.js` | MV3 service worker: `tabCapture` stream IDs, offscreen document lifecycle, keepalive port, organized WAV downloads, disk existence checks, update checker, and state sync |
| `offscreen.html` / `offscreen.js` | Offscreen DSP host: `getUserMedia` tab capture, `AudioWorkletNode` graph, live monitor `GainNode`, onset/silence watchdog, stereo auto-trim, and pure JS 16-bit Stereo RIFF WAVE encoder |
| `pcm-processor.js` | `AudioWorkletProcessor` with pre-allocated 4096-sample stereo buffers, mono-to-stereo safety, peak metering, and FIFO `STOP` tail flush |
| `content.js` | Configurable DOM sequencer: selector validation & testing, numbered + Next pagination, SPA render polling, infinite scroll fallback, `MutationObserver` playback detection, and filename sanitization |
| `popup.html` / `popup.css` / `popup.js` | `360px` dark-mode DAW-inspired control panel with live progress, transport controls, DSP settings, Target Selectors accordion, and Activity Log |

---

## Releasing a New Version (Auto-Update Pipeline)

This repository includes automated **GitHub Actions** workflows:
- **CI (`.github/workflows/ci.yml`)**: Runs syntax checks (`node --check`) and `manifest.json` validation on every push and pull request.
- **Auto Release (`.github/workflows/release.yml`)**: Whenever you bump `"version"` in `manifest.json` (e.g. `"1.0.0"` → `"1.1.0"`) and push to `main`, GitHub Actions automatically validates, zips the extension runtime files into `SlicexPackSaver-v1.1.0.zip`, and publishes a new GitHub Release.
- **In-Extension Notifier**: Once published, installed extensions automatically detect the newer GitHub Release and display a one-click update badge in the popup header.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
