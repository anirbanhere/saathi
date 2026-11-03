import { LocalError } from "./errors";

export const pcmWavMaxBytes = 2_000_000;

/** Wrap signed little-endian PCM16 without decoding, resampling or changing samples. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1) {
  if (
    !(pcm instanceof Uint8Array) ||
    ![1, 2].includes(channels) ||
    ![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate) ||
    pcm.length < channels * 2 ||
    pcm.length % (channels * 2) !== 0 ||
    pcm.length + 44 > pcmWavMaxBytes ||
    pcm.length > sampleRate * channels * 2 * 60
  )
    throw new LocalError("Invalid or oversized PCM16 audio.");
  const bytes = new Uint8Array(pcm.length + 44),
    view = new DataView(bytes.buffer),
    label = (at: number, text: string) =>
      bytes.set(new TextEncoder().encode(text), at);
  label(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  return bytes;
}

/** Bounded PCM16 RIFF/WAVE inspection, not a general codec decoder or transcoder. */
export function inspectPcmWav(bytes: Uint8Array) {
  const invalid = (): never => {
    throw new LocalError(
      "Use bounded PCM16 WAV audio, one or two channels, at most 60 seconds and 2MB.",
    );
  };
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 44 ||
    bytes.length > pcmWavMaxBytes
  )
    return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (offset: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + 4));
  if (
    label(0) !== "RIFF" ||
    label(8) !== "WAVE" ||
    view.getUint32(4, true) !== bytes.length - 8
  )
    return invalid();
  let offset = 12,
    count = 0,
    format: {
      channels: number;
      sampleRate: number;
      blockAlign: number;
    } | null = null,
    dataBytes: number | null = null;
  while (offset < bytes.length) {
    if (++count > 32 || offset + 8 > bytes.length) return invalid();
    const name = label(offset),
      size = view.getUint32(offset + 4, true),
      start = offset + 8,
      end = start + size;
    if (end + (size % 2) > bytes.length) return invalid();
    if (name === "fmt ") {
      if (
        format ||
        (size !== 16 && size !== 18) ||
        view.getUint16(start, true) !== 1 ||
        (size === 18 && view.getUint16(start + 16, true) !== 0)
      )
        return invalid();
      const channels = view.getUint16(start + 2, true),
        sampleRate = view.getUint32(start + 4, true),
        blockAlign = view.getUint16(start + 12, true);
      if (
        ![1, 2].includes(channels) ||
        ![8000, 16000, 22050, 24000, 44100, 48000].includes(sampleRate) ||
        view.getUint16(start + 14, true) !== 16 ||
        blockAlign !== channels * 2 ||
        view.getUint32(start + 8, true) !== sampleRate * blockAlign
      )
        return invalid();
      format = { channels, sampleRate, blockAlign };
    } else if (name === "data") {
      if (
        !format ||
        dataBytes !== null ||
        size < format.blockAlign ||
        size % format.blockAlign !== 0
      )
        return invalid();
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (
    !format ||
    dataBytes === null ||
    dataBytes > format.sampleRate * format.blockAlign * 60
  )
    return invalid();
  const frames = dataBytes / format.blockAlign;
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: 16 as const,
    frames,
    durationMs: (frames * 1000) / format.sampleRate,
    dataBytes,
  };
}
