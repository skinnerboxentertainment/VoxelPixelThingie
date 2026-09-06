/**
 * The demo's side of the LED bridge (ADR 0009). A sink that, for one bit,
 * posts the bit's state to scripts/led-drive.ts after every event that
 * touches it, with the event's time so the bridge can measure latency.
 * Browsers cannot send UDP; the bridge turns the post into DDP.
 *
 * Opened with ?led=http://127.0.0.1:4049&bit=<id>; bit=first follows the
 * first bit created after the sink attaches.
 */
import {
  type BitEvent,
  type Container,
  type EventSink,
  LED_FRAME_FORMAT,
  type LedFramePost,
} from "../../src/index.ts";

export class LedBridgeSink implements EventSink {
  readonly url: string;
  #target: string;
  #lookup: () => Container | undefined;
  /** Posts made, for the HUD and for tests. */
  posts = 0;
  lastError = "";

  constructor(url: string, target: string, lookup: () => Container | undefined) {
    this.url = url.replace(/\/$/, "");
    this.#target = target;
    this.#lookup = lookup;
  }

  /** The bit being mirrored; "first" until a bit is created. */
  get target(): string {
    return this.#target;
  }

  record(event: BitEvent): void {
    if (this.#target === "first" && event.type === "created") this.#target = event.bit;
    if (event.bit !== this.#target) return;
    const bit = this.#lookup()?.get(event.bit);
    const rec = bit?.record();
    const body: LedFramePost = {
      format: LED_FRAME_FORMAT,
      bit: event.bit,
      time: event.time,
      present: rec?.present ?? false,
      color: rec?.color ?? 0xffffff,
      emissions: rec?.emissions ?? [],
    };
    this.posts++;
    fetch(`${this.url}/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    })
      .then((res) => {
        if (!res.ok) this.lastError = `bridge answered ${res.status}`;
      })
      .catch((err: Error) => {
        this.lastError = err.message;
      });
  }
}
