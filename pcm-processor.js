/**
 * pcm-processor.js
 * AudioWorkletProcessor that buffers raw stereo Float32 PCM samples into
 * pre-allocated 4096-sample internal buffers to prevent IPC congestion,
 * dropped render quanta, and audio glitches.
 */

const CHUNK_SIZE = 4096;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this.recordingId = null;

    // Pre-allocated internal stereo accumulation buffers (zero GC in hot audio path)
    this.leftBuf = new Float32Array(CHUNK_SIZE);
    this.rightBuf = new Float32Array(CHUNK_SIZE);
    this.writeIndex = 0;
    this.chunkPeak = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'START') {
        this.writeIndex = 0;
        this.chunkPeak = 0;
        this.recordingId = msg.recordingId ?? null;
        this.isRecording = true;
      } else if (msg.type === 'STOP') {
        const stopRecordingId = msg.recordingId ?? this.recordingId;
        this.isRecording = false;

        if (msg.flush !== false && this.writeIndex > 0) {
          this.flushBuffer();
        } else {
          this.writeIndex = 0;
          this.chunkPeak = 0;
        }

        // Send FIFO-ordered STOPPED acknowledgment after any flushed partial chunk
        this.port.postMessage({
          type: 'STOPPED',
          recordingId: stopRecordingId
        });
        this.recordingId = null;
      }
    };
  }

  /**
   * Clones and transfers the accumulated stereo slice [0, writeIndex) to offscreen.js
   * so the audio rendering thread never mutates posted buffers.
   */
  flushBuffer() {
    const frameCount = this.writeIndex;
    if (frameCount <= 0) return;

    const leftCopy = this.leftBuf.slice(0, frameCount);
    const rightCopy = this.rightBuf.slice(0, frameCount);
    const peak = this.chunkPeak;

    this.writeIndex = 0;
    this.chunkPeak = 0;

    this.port.postMessage(
      {
        type: 'PCM_CHUNK',
        recordingId: this.recordingId,
        left: leftCopy,
        right: rightCopy,
        peak,
        frameCount
      },
      [leftCopy.buffer, rightCopy.buffer]
    );
  }

  /**
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} _outputs
   * @param {Record<string, Float32Array>} _parameters
   * @returns {boolean}
   */
  process(inputs, _outputs, _parameters) {
    if (!this.isRecording) {
      return true;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const leftIn = input[0];
    if (!leftIn || leftIn.length === 0) {
      return true;
    }

    // Handle mono inputs safely: duplicate channel 0 into right channel so L & R lengths always match.
    const rightIn = (input.length > 1 && input[1] && input[1].length === leftIn.length)
      ? input[1]
      : leftIn;

    const totalIn = leftIn.length;
    let readOffset = 0;

    while (readOffset < totalIn) {
      const spaceRemaining = CHUNK_SIZE - this.writeIndex;
      const toCopy = Math.min(spaceRemaining, totalIn - readOffset);

      for (let i = 0; i < toCopy; i++) {
        const l = leftIn[readOffset + i];
        const r = rightIn[readOffset + i];
        const dstIdx = this.writeIndex + i;

        this.leftBuf[dstIdx] = l;
        this.rightBuf[dstIdx] = r;

        if (Number.isFinite(l)) {
          const absL = l < 0 ? -l : l;
          if (absL > this.chunkPeak) this.chunkPeak = absL;
        }
        if (Number.isFinite(r)) {
          const absR = r < 0 ? -r : r;
          if (absR > this.chunkPeak) this.chunkPeak = absR;
        }
      }

      this.writeIndex += toCopy;
      readOffset += toCopy;

      if (this.writeIndex >= CHUNK_SIZE) {
        this.flushBuffer();
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
