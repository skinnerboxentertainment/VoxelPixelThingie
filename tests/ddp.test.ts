import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelsPerLed,
  DDP_FLAGS,
  DDP_HEADER_LENGTH,
  DDP_ID,
  DDP_MAX_DATA,
  DDP_PORT,
  DDP_TYPE,
  ddpFrame,
  decodeDdp,
  encodeDdp,
  ledRangeOf,
  nextSequence,
} from "../src/ddp.ts";
import { defaultLedMap, ledFrame } from "../src/led-map.ts";

test("constants match WLED's ESPAsyncE131.h", () => {
  assert.equal(DDP_PORT, 4048);
  assert.equal(DDP_HEADER_LENGTH, 10);
  assert.equal(DDP_MAX_DATA, 1440);
  assert.equal(DDP_FLAGS.VERSION_1, 0x40);
  assert.equal(DDP_FLAGS.PUSH, 0x01);
  assert.equal(DDP_FLAGS.QUERY, 0x02);
  assert.equal(DDP_FLAGS.REPLY, 0x04);
  assert.equal(DDP_FLAGS.STORAGE, 0x08);
  assert.equal(DDP_FLAGS.TIMECODE, 0x10);
  assert.equal(DDP_TYPE.RGB24, 0x0b);
  assert.equal(DDP_TYPE.RGBW32, 0x1b);
  assert.equal(DDP_ID.DISPLAY, 1);
  assert.equal(DDP_ID.ALL, 255);
});

test("the header bytes, exactly", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const p = encodeDdp(data, { offset: 0x01020304, sequence: 7 });
  assert.deepEqual(
    [...p.subarray(0, 10)],
    [0x41, 0x07, 0x0b, 0x01, 0x01, 0x02, 0x03, 0x04, 0x00, 0x06],
  );
  assert.deepEqual([...p.subarray(10)], [1, 2, 3, 4, 5, 6]);
  const noPush = encodeDdp(data, { push: false });
  assert.equal(noPush[0], 0x40);
  assert.equal(noPush[1], 0, "sequence off by default");
  const rgbw = encodeDdp(new Uint8Array(8), { type: DDP_TYPE.RGBW32, id: DDP_ID.ALL });
  assert.equal(rgbw[2], 0x1b);
  assert.equal(rgbw[3], 255);
  assert.throws(() => encodeDdp(new Uint8Array(DDP_MAX_DATA + 1)), /splits/);
  assert.throws(() => encodeDdp(data, { sequence: 16 }), /sequence/);
  assert.throws(() => encodeDdp(data, { offset: -1 }), /offset/);
});

test("decode reads back what encode wrote, computes WLED's LED range, and skips a timecode", () => {
  const data = new Uint8Array(30).map((_, i) => i);
  const { header, data: back } = decodeDdp(encodeDdp(data, { offset: 12, sequence: 15 }));
  assert.deepEqual(header, {
    version: 1,
    push: true,
    query: false,
    reply: false,
    storage: false,
    timecode: false,
    sequence: 15,
    type: DDP_TYPE.RGB24,
    id: DDP_ID.DISPLAY,
    offset: 12,
    length: 30,
  });
  assert.deepEqual([...back], [...data]);
  assert.deepEqual(ledRangeOf(header), { start: 4, stop: 14 });
  assert.equal(channelsPerLed(DDP_TYPE.RGB24), 3);
  assert.equal(channelsPerLed(DDP_TYPE.RGBW32), 4);
  assert.equal(channelsPerLed(DDP_TYPE.LEGACY_RGB), 3);
  assert.deepEqual(ledRangeOf({ ...header, type: DDP_TYPE.RGBW32, offset: 8, length: 8 }), {
    start: 2,
    stop: 4,
  });

  // A packet with the timecode flag carries four more header bytes before the data.
  const timed = new Uint8Array(14 + 3);
  timed[0] = DDP_FLAGS.VERSION_1 | DDP_FLAGS.TIMECODE | DDP_FLAGS.PUSH;
  timed[2] = DDP_TYPE.RGB24;
  timed[3] = 1;
  timed[9] = 3;
  timed.set([9, 8, 7], 14);
  const t = decodeDdp(timed);
  assert.equal(t.header.timecode, true);
  assert.deepEqual([...t.data], [9, 8, 7]);

  assert.throws(() => decodeDdp(new Uint8Array(9)), /shorter/);
  const short = encodeDdp(new Uint8Array(4));
  assert.throws(() => decodeDdp(short.subarray(0, 12)), /header says 4/);
});

test("a frame splits at the packet limit with push only on the last packet, sequences counting up", () => {
  const frame = new Uint8Array(600 * 3).map((_, i) => i & 0xff);
  const packets = ddpFrame(frame, { sequence: 14 });
  assert.equal(packets.length, 2);
  const a = decodeDdp(packets[0]!);
  const b = decodeDdp(packets[1]!);
  assert.equal(a.header.length, 1440);
  assert.equal(a.header.offset, 0);
  assert.equal(a.header.push, false);
  assert.equal(a.header.sequence, 14);
  assert.equal(b.header.length, 360);
  assert.equal(b.header.offset, 1440);
  assert.equal(b.header.push, true);
  assert.equal(b.header.sequence, 15);
  assert.deepEqual(ledRangeOf(a.header), { start: 0, stop: 480 });
  assert.deepEqual(ledRangeOf(b.header), { start: 480, stop: 600 });
  assert.deepEqual([...a.data, ...b.data], [...frame]);
  assert.equal(nextSequence(15), 1);
  assert.equal(nextSequence(1), 2);
  // Sequencing off stays off.
  const off = ddpFrame(frame);
  assert.equal(decodeDdp(off[1]!).header.sequence, 0);
  // A custom split.
  assert.equal(ddpFrame(frame, { maxData: 300 }).length, 6);
  assert.throws(() => ddpFrame(frame, { maxData: 301 }), /multiple of 3/);
  // An empty frame is one push packet with no data.
  const empty = ddpFrame(new Uint8Array(0));
  assert.equal(empty.length, 1);
  assert.equal(decodeDdp(empty[0]!).header.length, 0);
});

test("the physical bit fits one packet: 68 LEDs, 204 data bytes, push set", () => {
  const map = defaultLedMap();
  const frame = ledFrame(
    {
      present: true,
      color: 0xffffff,
      emissions: Array.from({ length: 26 }, () => ({ color: 0x1f6feb, light: 1 })),
    },
    map,
  );
  const packets = ddpFrame(frame, { sequence: 1 });
  assert.equal(packets.length, 1);
  const { header, data } = decodeDdp(packets[0]!);
  assert.equal(packets[0]!.length, DDP_HEADER_LENGTH + 204);
  assert.equal(header.push, true);
  assert.deepEqual(ledRangeOf(header), { start: 0, stop: 68 });
  assert.deepEqual([...data.subarray(0, 3)], [0x1f, 0x6f, 0xeb]);
  assert.deepEqual([...data.subarray(201, 204)], [0x1f, 0x6f, 0xeb]);
});
