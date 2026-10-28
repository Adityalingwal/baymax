// Turns one block of microphone samples into 16 kHz mono 16-bit little-endian PCM, averaging the samples
// each output sample covers. `start` is where the block's first output sample begins; `next` carries it on.
// It runs inside the AudioWorklet as source text, so it must not use anything outside its own body.
export function toPcm16(
  input: Float32Array,
  fromRate: number,
  start: number,
): { bytes: Uint8Array; next: number } {
  const step = fromRate / 16000;
  const count = Math.max(0, Math.ceil((input.length - start) / step));
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    const begin = start + index * step;
    const first = Math.floor(begin);
    const end = Math.max(first + 1, Math.floor(begin + step));
    const last = Math.min(input.length, end);
    let sum = 0;
    for (let at = first; at < last; at += 1) sum += input[at];
    const sample = Math.max(-1, Math.min(1, sum / (last - first)));
    view.setInt16(
      index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return { bytes, next: start + count * step - input.length };
}

// Streamed speech arrives as 16-bit little-endian PCM; Web Audio plays floats from -1 to 1.
export function fromPcm16(pcm: ArrayBuffer): Float32Array {
  const view = new DataView(pcm);
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}
