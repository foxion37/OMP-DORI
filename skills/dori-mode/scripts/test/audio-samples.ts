// Generated from 25 ms of synthetic mono silence with ffmpeg, not captured user audio.
// WAV: pcm_s16le; MP3: libmp3lame; Ogg: libopus; M4A: AAC fragmented MP4; FLAC: flac.
// Runtime and CI do not need ffmpeg: these immutable bytes exercise the actual container signatures.
export const audioSamples = {
  wav: "UklGRv////9XQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAATElTVBoAAABJTkZPSVNGVA4AAABMYXZmNjAuMTYuMTAwAGRhdGH/////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  mp3: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
  ogg: "T2dnUwACAAAAAAAAAACagSv6AAAAABTlq3gBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAJqBK/oBAAAAVzTdfAE+T3B1c1RhZ3MNAAAATGF2ZjYwLjE2LjEwMAEAAAAdAAAAZW5jb2Rlcj1MYXZjNjAuMzEuMTAyIGxpYm9wdXNPZ2dTAAToBQAAAAAAAJqBK/oCAAAAZ9WzbQIDA/j//vj//g==",
  m4a: "AAAAIGZ0eXBNNEEgAAACAE00QSBpc282aXNvMm1wNDEAAAK9bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAAAAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAb90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAFbbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAABBm1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAAynN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAC7gAAAu4AFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAC7gAAAu4AAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAChtdmV4AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAHxtb29mAAAAEG1maGQAAAAAAAAAAQAAAGR0cmFmAAAAJHRmaGQAAAA5AAAAAQAAAAAAAALdAAAEAAAAABUCAAAAAAAAFHRmZHQBAAAAAAAAAAAAAAAAAAAkdHJ1bgAAAwEAAAACAAAAhAAABAAAAAAVAAAAyAAAAAQAAAAhbWRhdN4CAExhdmM2MC4zMS4xMDIAAjBADgEYIAcAAABDbWZyYQAAACt0ZnJhAQAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAt0BAQEAAAAQbWZybwAAAAAAAABD",
  flac: "ZkxhQwAAACICQAJAAAAAAASVAfQA8AAAAAAAAAAAAAAAAAAAAAAAAAAAhAAALg0AAABMYXZmNjAuMTYuMTAwAQAAABUAAABlbmNvZGVyPUxhdmY2MC4xNi4xMDD/+GQIAMe4AAAAl1E=",
} as const;

// Re-label the existing three equal-sized Layer III frames as free-format without changing their audio data.
const freeFormat = Buffer.from(audioSamples.mp3, "base64");
for (const frame of [45, 117, 189]) freeFormat[frame + 2] = freeFormat.readUInt8(frame + 2) & 0x0f;

const mp4Box = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + data.length);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, data]);
};

// Insert an empty mdat before moov while preserving the real AAC fragment.
const fragmented = Buffer.from(audioSamples.m4a, "base64");
const ftypEnd = fragmented.readUInt32BE(0);
const earlyMdat = mp4Box("mdat");
// Relocate the explicit tfhd base-data-offset and omit the optional mfra index.
const baseDataOffset = 781;
fragmented.writeBigUInt64BE(fragmented.readBigUInt64BE(baseDataOffset) + BigInt(earlyMdat.length), baseDataOffset);
const lateMoov = Buffer.concat([fragmented.subarray(0, ftypEnd), earlyMdat, fragmented.subarray(ftypEnd, 890)]);

// Identification-only fixtures: valid first codec packets/pages, without encoded pictures or samples.
const oggBos = (packet: Buffer, serial: number): Buffer => {
  const page = Buffer.alloc(28 + packet.length);
  page.write("OggS");
  page[5] = 2;
  page.writeUInt32LE(serial, 14);
  page[26] = 1;
  page[27] = packet.length;
  packet.copy(page, 28);
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  }
  page.writeUInt32LE(crc >>> 0, 22);
  return page;
};

const theora = Buffer.alloc(42);
theora.write("\x80theora", "latin1");
theora.set([3, 2, 1], 7);
theora.writeUInt16BE(1, 10);
theora.writeUInt16BE(1, 12);
theora.writeUIntBE(16, 14, 3);
theora.writeUIntBE(16, 17, 3);
theora.writeUInt32BE(25, 22);
theora.writeUInt32BE(1, 26);
const videoBos = oggBos(theora, 1);

const vorbis = Buffer.alloc(30);
vorbis.write("\x01vorbis", "latin1");
vorbis[11] = 1;
vorbis.writeUInt32LE(44100, 12);
vorbis.set([0xb8, 1], 28);

const opusMapped = Buffer.alloc(24);
opusMapped.write("OpusHead");
opusMapped.set([1, 3], 8);
opusMapped.writeUInt32LE(48000, 12);
opusMapped.set([1, 2, 1, 0, 2, 1], 18);

// Video-only MP4 track metadata with the usual video handler; no encoded video payload.
const videoHandler = Buffer.alloc(25);
videoHandler.write("vide", 8);
const track = (handler: Buffer): Buffer => mp4Box("trak", mp4Box("mdia", mp4Box("hdlr", handler)));
const videoMoov = mp4Box("moov", track(videoHandler));
const audioHandler = Buffer.alloc(25);
audioHandler.write("soun", 8);
const videoFtyp = mp4Box("ftyp", Buffer.from("isom\x00\x00\x00\x00isom", "latin1"));

export const trackSamples = {
  freeFormat: freeFormat.toString("base64"),
  lateMoov: lateMoov.toString("base64"),
  vorbis: Buffer.concat([videoBos, oggBos(vorbis, 2)]).toString("base64"),
  videoOgg: videoBos.toString("base64"),
  videoMp4: Buffer.concat([videoFtyp, videoMoov]).toString("base64"),
  opusMapped: oggBos(opusMapped, 3).toString("base64"),
  audioVideoMp4: Buffer.concat([
    videoFtyp,
    mp4Box("moov", Buffer.concat([track(videoHandler), track(audioHandler)])),
  ]).toString("base64"),
};
