const headerBytes = 44;

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

// A WAV header in front of 16-bit mono PCM, so the pre-recorded call can read a held clip.
export function wavFromPcm(pcm: Uint8Array, sampleRate: number): ArrayBuffer {
  const wav = new ArrayBuffer(headerBytes + pcm.byteLength);
  const view = new DataView(wav);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, headerBytes - 8 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(wav, headerBytes).set(pcm);
  return wav;
}
