/**
 * Pure PCM helpers for the Discord voice bridge. Discord carries 48 kHz stereo; the Live session takes 24 kHz mono
 * PCM16. Nothing here loads a native codec or touches the network.
 */

/** One 20 ms frame of 48 kHz stereo PCM16, the unit the Discord player consumes. */
const FRAME_BYTES = 3840;
const PLAYBACK_MAX_BYTES = 250 * FRAME_BYTES; // 5 s of stereo PCM

/** Averages each pair of 48 kHz stereo sample frames into one 24 kHz mono sample. */
export const downTo24kMono = (pcm48: Buffer): Buffer => {
  const frames = pcm48.length >> 2;
  const out = Buffer.alloc((frames >> 1) * 2);
  for (let i = 0, o = 0; i + 1 < frames; i += 2, o += 2) {
    const a = pcm48.readInt16LE(i * 4) + pcm48.readInt16LE(i * 4 + 2);
    const b = pcm48.readInt16LE(i * 4 + 4) + pcm48.readInt16LE(i * 4 + 6);
    out.writeInt16LE(Math.round((a + b) / 4), o);
  }
  return out;
};

/** Level of PCM16 audio in dBFS; silence and empty input read as -120. */
export const rmsDbfs = (pcm: Buffer): number => {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / Math.max(n, 1)) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -120;
};

/**
 * The model's speech on its way to Discord: 24 kHz mono chunks go in, 20 ms 48 kHz stereo frames come out on demand.
 * Upsampling interpolates across chunk boundaries, so the previous sample belongs to the queue and resets with it.
 */
export class Playback {
  /** Called after every write so a reader waiting for data can take the next frame. */
  onReadable: (() => void) | undefined;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private previous = 0;
  private frames = 0;
  private revision = 0;
  audible = true;
  get generation(): number {
    return this.revision;
  }
  get playedFrames(): number {
    return this.frames;
  }

  /** False means the queue overflowed and its generation was discarded. */
  write(pcm24: Buffer): boolean {
    if (!this.audible) return true;
    const n = Math.floor(pcm24.length / 2);
    if (!n) return true;
    if (n * 8 > PLAYBACK_MAX_BYTES - this.bytes) {
      this.clear();
      return false;
    }
    const out = Buffer.alloc(n * 8);
    for (let i = 0; i < n; i++) {
      const s = pcm24.readInt16LE(i * 2);
      const mid = (this.previous + s) >> 1;
      out.writeInt16LE(mid, i * 8);
      out.writeInt16LE(mid, i * 8 + 2);
      out.writeInt16LE(s, i * 8 + 4);
      out.writeInt16LE(s, i * 8 + 6);
      this.previous = s;
    }
    this.chunks.push(out);
    this.bytes += out.length;
    this.onReadable?.();
    return true;
  }

  /** The next 20 ms frame, or null while less than a whole frame is queued. */
  read(): Buffer | null {
    if (this.bytes < FRAME_BYTES) return null;
    const frame = Buffer.alloc(FRAME_BYTES);
    let filled = 0;
    while (filled < FRAME_BYTES) {
      const head = this.chunks[0]!;
      const take = Math.min(head.length, FRAME_BYTES - filled);
      head.copy(frame, filled, 0, take);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.bytes -= FRAME_BYTES;
    this.frames++;
    return frame;
  }

  /** Finishes a quiet speech tail without carrying its samples into the next turn. */
  flushTail(): void {
    if (!this.audible || this.bytes === 0 || this.bytes >= FRAME_BYTES) return;
    this.chunks.push(Buffer.alloc(FRAME_BYTES - this.bytes));
    this.bytes = FRAME_BYTES;
    this.previous = 0;
    this.onReadable?.();
  }

  clear(): void {
    this.revision++;
    this.chunks = [];
    this.bytes = 0;
    this.previous = 0;
  }

  queuedMs(): number {
    return (this.bytes / FRAME_BYTES) * 20;
  }
}

// The Live input drops audio sent faster than 1.2x real time or in bursts over 5 s (probed 2026-11-17: 5 s at
// session start and a 5 s burst after steady streaming pass; 6.5 s and 8 s are rejected). Every append, audio or
// silence, spends tokens from a bucket that refills at 1.15x real time and holds at most 3 s; it starts full, so a
// wake preroll goes out at once and no burst exceeds 3 s, even after a long steady stretch or an event-loop stall.
const BUCKET_RATE = 24 * 1.15; // 24 kHz samples per ms
const BUCKET_MAX = 24_000 * 3;

/**
 * Splits the samples that may be sent now between queued owner audio and padding silence. Silence only keeps the
 * stream at real time: it pads when more than 100 ms behind, within the tokens left after the audio. A bucket created
 * with `tokens: Infinity` starts full, because the refill clamps it to the 3 s ceiling.
 */
export const paceInput = (
  bucket: { tokens: number; last: number },
  now: number,
  pendingSamples: number,
  behindSamples: number,
): { audio: number; silence: number } => {
  bucket.tokens = Math.min(BUCKET_MAX, bucket.tokens + (now - bucket.last) * BUCKET_RATE);
  bucket.last = now;
  const audio = Math.min(pendingSamples, Math.floor(bucket.tokens));
  bucket.tokens -= audio;
  const behind = behindSamples - audio;
  const silence = behind > 2400 ? Math.min(behind, Math.floor(bucket.tokens)) : 0;
  bucket.tokens -= silence;
  return { audio, silence };
};

/** Owns the input queue and its real-time budget for exactly one Live session. */
export class InputAudio {
  private readonly bucket: { tokens: number; last: number };
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private sentSamples = 0;
  constructor(private readonly since: number) {
    this.bucket = { tokens: BUCKET_MAX, last: since };
  }
  push(pcm: Buffer): boolean {
    if (pcm.length % 2 !== 0 || pcm.length > BUCKET_MAX * 2 - this.pendingBytes) return false;
    if (pcm.length) this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    return true;
  }
  drain(now: number): Buffer[] {
    const pending = this.pendingBytes / 2;
    const behind = Math.floor((now - this.since) * 24) - this.sentSamples;
    const paced = paceInput(this.bucket, now, pending, behind);
    const output: Buffer[] = [];
    if (paced.audio) {
      const parts: Buffer[] = [];
      let remaining = paced.audio * 2;
      while (remaining > 0 && this.pending.length) {
        const head = this.pending[0]!;
        const take = Math.min(remaining, head.length);
        parts.push(head.subarray(0, take));
        if (take === head.length) this.pending.shift();
        else this.pending[0] = head.subarray(take);
        remaining -= take;
      }
      output.push(Buffer.concat(parts));
      this.pendingBytes -= paced.audio * 2;
    }
    if (paced.silence) output.push(Buffer.alloc(paced.silence * 2));
    this.sentSamples += paced.audio + paced.silence;
    return output;
  }
}
