# ADR 0015: Senses are annotations with units

Date: 2026-09-06. Status: accepted.

## Context

The physical bit receives frames (ADR 0009) and says nothing back.
PUNCHLIST.md item 5 asked for the other direction: what the bit feels,
light, heat, touch, written into its own history with units and exported
so a supply-chain system reads it as a sensor event. The EPCIS export
already wrote `sensorElementList` for emissions, with nothing physical in
it; EPCIS 2.0 and CBV 2.0 define the sensor vocabulary (measurement
types such as `gs1:Temperature`, UN/CEFACT units such as `CEL`), and
WLED, the firmware the physical bit runs, exposes usermod sensors in an
`info.sensor` array of its JSON API, a shape its documentation still
marks as a draft.

## Decision

- **No new event type.** A reading is an `annotated` event under a
  reserved key `sense:<quantity>`, the precedent set by job records (ADR
  0010) and the policy (ADR 0014). The value is `{ value, uom, time,
  device?, min?, max? }`; the sink refuses anything else.
- **Units are UN/CEFACT codes, types are CBV.** `src/senses.ts` holds the
  table: temperature CEL, illuminance LUX, humidity P1, pressure PAL,
  and touch C62 under our own `vpb:Touch`. The EPCIS export uses the
  standard `sensorReport` fields (`type`, `value`, `uom`, `minValue`,
  `maxValue`) and `sensorMetadata` (`time`, `deviceID`) so no extension
  schema is needed to read a reading.
- **The device is the actor.** Readings are recorded under
  `actor: "device:<host>"` with cause `sense`, so the ledger says which
  device felt what, as it says which person carved what.
- **Compaction keeps the last reading per quantity.** Readings are not
  in the passport, so a compacted ledger would otherwise forget how warm
  the bit was; the last of each quantity survives the tail.
- **The twin reports senses before the hardware does.** The simulator's
  `--sensors` puts a drifting temperature and illuminance in
  `info.sensor`, in the draft shape; the driver's `--senses` polls any
  device's `info.sensor` through one path, so the real bit needs no
  second one.

## Consequences

- SPEC v0.9 §9.9. Existing scenes are unchanged.
- The WLED sensor API is a draft (Verified in its documentation
  2026-09-06); the letter-to-quantity mapping (`T`, `L`, `H`, `P`) is
  Trusted until a usermod build reports through it on the physical bit
  (#72), which the Phase 21 journal will record.
- A reading's time is the driver's clock at the poll, not the device's
  uptime, which is all WLED offers; the ledger's own `time` is the
  sink's clock. The two are recorded separately and neither is claimed
  to be the other.
- Touch is a count, unitless, ours; a device with a touch sensor reports
  it under `vpb:Touch`, which no EPCIS vocabulary defines. That is the
  one place the export leaves the standard vocabulary, and it says so by
  the prefix.
