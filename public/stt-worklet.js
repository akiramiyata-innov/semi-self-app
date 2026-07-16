// AudioWorklet for streaming STT: converts mic audio (Float32, at the context's
// 16kHz rate) to 16-bit PCM and posts it to the main thread in ~100ms chunks,
// which are then streamed to the server over Socket.IO as `stt:audio`.
class STTProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._count = 0;
    this._target = 1600; // 100ms @ 16kHz
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      const pcm = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this._chunks.push(pcm);
      this._count += pcm.length;
      if (this._count >= this._target) {
        const out = new Int16Array(this._count);
        let o = 0;
        for (const c of this._chunks) { out.set(c, o); o += c.length; }
        this.port.postMessage(out.buffer, [out.buffer]);
        this._chunks = [];
        this._count = 0;
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor("stt-processor", STTProcessor);
