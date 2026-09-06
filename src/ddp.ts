/**
 * DDP, the Distributed Display Protocol (3waylabs.com/ddp, read 2026-09-06):
 * a 10-byte header and pixel bytes over UDP 4048. WLED receives it
 * (wled00/e131.cpp, same date): start LED = offset / channels per LED, and
 * the display renders when a packet carries the push flag, or when it has
 * never seen one.
 *
 *   byte 0    flags   VV x T S R Q P: version (01), timecode, storage, reply, query, push
 *   byte 1    sequence, low nibble, 1..15, 0 when unused
 *   byte 2    data type  C R TTT SSS: RGB 8-bit is 0x0B, RGBW 8-bit is 0x1B
 *   byte 3    destination id, 1 is the display
 *   bytes 4-7 data offset in bytes, big-endian
 *   bytes 8-9 data length in bytes, big-endian
 *   bytes 10-13 timecode when the T flag is set (WLED skips it)
 */

export const DDP_PORT = 4048;
export const DDP_HEADER_LENGTH = 10;
/** Data bytes per packet that fit an Ethernet frame: 480 RGB LEDs. */
export const DDP_MAX_DATA = 1440;

export const DDP_FLAGS = {
  VERSION_MASK: 0xc0,
  VERSION_1: 0x40,
  TIMECODE: 0x10,
  STORAGE: 0x08,
  REPLY: 0x04,
  QUERY: 0x02,
  PUSH: 0x01,
} as const;

export const DDP_TYPE = {
  UNDEFINED: 0x00,
  LEGACY_RGB: 0x01,
  RGB24: 0x0b,
  RGBW32: 0x1b,
} as const;

export const DDP_ID = {
  DISPLAY: 1,
  CONTROL: 246,
  CONFIG: 250,
  STATUS: 251,
  DMX: 254,
  ALL: 255,
} as const;

export interface DdpHeader {
  version: number;
  push: boolean;
  query: boolean;
  reply: boolean;
  storage: boolean;
  timecode: boolean;
  sequence: number;
  type: number;
  id: number;
  offset: number;
  length: number;
}

export interface DdpPacketOptions {
  /** Byte offset into the display's buffer. Default 0. */
  offset?: number;
  /** Render now. Default true. */
  push?: boolean;
  /** 1..15, or 0 for none. Default 0. */
  sequence?: number;
  /** Default RGB24. */
  type?: number;
  /** Default the display. */
  id?: number;
}

/** One packet: header plus data. Data is at most DDP_MAX_DATA bytes. */
export function encodeDdp(data: Uint8Array, opts: DdpPacketOptions = {}): Uint8Array {
  if (data.length > DDP_MAX_DATA)
    throw new Error(
      `ddp: ${data.length} data bytes in one packet; ddpFrame splits at ${DDP_MAX_DATA}`,
    );
  const offset = opts.offset ?? 0;
  const sequence = opts.sequence ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff)
    throw new Error(`ddp: offset ${offset} is not a 32-bit unsigned integer`);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 15)
    throw new Error(`ddp: sequence ${sequence} is not 0..15`);
  const out = new Uint8Array(DDP_HEADER_LENGTH + data.length);
  out[0] = DDP_FLAGS.VERSION_1 | ((opts.push ?? true) ? DDP_FLAGS.PUSH : 0);
  out[1] = sequence;
  out[2] = opts.type ?? DDP_TYPE.RGB24;
  out[3] = opts.id ?? DDP_ID.DISPLAY;
  out[4] = (offset >>> 24) & 0xff;
  out[5] = (offset >>> 16) & 0xff;
  out[6] = (offset >>> 8) & 0xff;
  out[7] = offset & 0xff;
  out[8] = (data.length >>> 8) & 0xff;
  out[9] = data.length & 0xff;
  out.set(data, DDP_HEADER_LENGTH);
  return out;
}

/** The header and the data of a packet. Throws on a short or inconsistent one. */
export function decodeDdp(packet: Uint8Array): { header: DdpHeader; data: Uint8Array } {
  if (packet.length < DDP_HEADER_LENGTH) throw new Error("ddp: packet shorter than its header");
  const flags = packet[0]!;
  const header: DdpHeader = {
    version: (flags & DDP_FLAGS.VERSION_MASK) >>> 6,
    push: (flags & DDP_FLAGS.PUSH) !== 0,
    query: (flags & DDP_FLAGS.QUERY) !== 0,
    reply: (flags & DDP_FLAGS.REPLY) !== 0,
    storage: (flags & DDP_FLAGS.STORAGE) !== 0,
    timecode: (flags & DDP_FLAGS.TIMECODE) !== 0,
    sequence: packet[1]! & 0x0f,
    type: packet[2]!,
    id: packet[3]!,
    offset: ((packet[4]! << 24) | (packet[5]! << 16) | (packet[6]! << 8) | packet[7]!) >>> 0,
    length: (packet[8]! << 8) | packet[9]!,
  };
  const dataStart = DDP_HEADER_LENGTH + (header.timecode ? 4 : 0);
  if (packet.length < dataStart + header.length)
    throw new Error(
      `ddp: header says ${header.length} data bytes, packet has ${packet.length - dataStart}`,
    );
  return { header, data: packet.subarray(dataStart, dataStart + header.length) };
}

/** Bytes per LED for a data type byte, the way WLED reads it: RGBW is TTT 011. */
export function channelsPerLed(type: number): number {
  return (type & 0b00111000) >>> 3 === 0b011 ? 4 : 3;
}

/** The LED range a packet writes, as WLED computes it from offset and length. */
export function ledRangeOf(header: DdpHeader): { start: number; stop: number } {
  const cpl = channelsPerLed(header.type);
  const start = Math.floor(header.offset / cpl);
  return { start, stop: start + Math.floor(header.length / cpl) };
}

export interface DdpFrameOptions {
  /** Sequence number for the first packet, 1..15; 0 leaves sequencing off. Default 0. */
  sequence?: number;
  /** Data bytes per packet. Default DDP_MAX_DATA. Must be a multiple of the LED's channels. */
  maxData?: number;
  type?: number;
  id?: number;
}

/**
 * A whole frame as packets: the last one carries push, the others do not,
 * so a display that honors push shows the frame once it is complete.
 * Sequence numbers count up from `sequence`, wrapping 15 to 1.
 */
export function ddpFrame(frame: Uint8Array, opts: DdpFrameOptions = {}): Uint8Array[] {
  const maxData = opts.maxData ?? DDP_MAX_DATA;
  const cpl = channelsPerLed(opts.type ?? DDP_TYPE.RGB24);
  if (maxData <= 0 || maxData > DDP_MAX_DATA || maxData % cpl !== 0)
    throw new Error(`ddp: maxData ${maxData} must be 1..${DDP_MAX_DATA} and a multiple of ${cpl}`);
  const packets: Uint8Array[] = [];
  let sequence = opts.sequence ?? 0;
  if (frame.length === 0) return [encodeDdp(frame, { push: true, sequence, ...pick(opts) })];
  for (let offset = 0; offset < frame.length; offset += maxData) {
    const data = frame.subarray(offset, Math.min(offset + maxData, frame.length));
    const last = offset + maxData >= frame.length;
    packets.push(encodeDdp(data, { offset, push: last, sequence, ...pick(opts) }));
    if (sequence !== 0) sequence = nextSequence(sequence);
  }
  return packets;
}

/** 1..15, wrapping. */
export function nextSequence(sequence: number): number {
  return (sequence % 15) + 1;
}

function pick(opts: DdpFrameOptions): { type?: number; id?: number } {
  const out: { type?: number; id?: number } = {};
  if (opts.type !== undefined) out.type = opts.type;
  if (opts.id !== undefined) out.id = opts.id;
  return out;
}
