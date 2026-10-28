import { describe, expect, it } from "vitest";
import { wavFromPcm } from "./wav";

describe("WAV from PCM", () => {
  it("puts a 16 kHz mono 16-bit header in front of the samples", () => {
    const wav = wavFromPcm(new Uint8Array([1, 2, 3, 4]), 16_000);
    const view = new DataView(wav);
    const ascii = (offset: number) =>
      String.fromCharCode(...new Uint8Array(wav, offset, 4));
    expect(wav.byteLength).toBe(48);
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual([
      "RIFF",
      "WAVE",
      "fmt ",
      "data",
    ]);
    expect([
      view.getUint32(4, true),
      view.getUint16(20, true),
      view.getUint16(22, true),
      view.getUint32(24, true),
      view.getUint32(28, true),
      view.getUint16(32, true),
      view.getUint16(34, true),
      view.getUint32(40, true),
    ]).toEqual([40, 1, 1, 16_000, 32_000, 2, 16, 4]);
    expect([...new Uint8Array(wav, 44)]).toEqual([1, 2, 3, 4]);
  });
});
