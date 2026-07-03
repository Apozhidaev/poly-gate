import { describe, expect, it } from "vitest";
import { toPostEvent, type RawEvent } from "../src/lib/postEvent.js";

const eventId = "evt-1";

const activeMarket = (overrides: Record<string, unknown> = {}) => ({
  id: "1",
  conditionId: "0xabc",
  active: true,
  groupItemThreshold: 0,
  ...overrides,
});

describe("toPostEvent", () => {
  it("maps Polymarket deadline to end of calendar day in America/New_York (winter EST)", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: "1",
          groupItemTitle: "January 15, 2026",
        }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.calendar).toBe(true);
    expect(event.deadline).toBe("2026-01-16T04:59:59.999Z");
    expect(event.markets?.[0].deadline).toBe("2026-01-16T04:59:59.999Z");
  });

  it("maps Polymarket deadline to end of calendar day in America/New_York (summer EDT)", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-07-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: "1",
          groupItemTitle: "July 15, 2026",
        }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.deadline).toBe("2026-07-16T03:59:59.999Z");
    expect(event.markets?.[0].deadline).toBe("2026-07-16T03:59:59.999Z");
  });

  it("backfills missing years from event start date", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-03-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: "1",
          groupItemTitle: "March 15",
          groupItemThreshold: 0,
        }),
        activeMarket({
          id: "2",
          groupItemTitle: "April 1",
          groupItemThreshold: 1,
        }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.calendar).toBe(true);
    expect(event.markets?.[0].deadline).toBe("2026-03-16T03:59:59.999Z");
    expect(event.markets?.[1].deadline).toBe("2026-04-02T03:59:59.999Z");
  });

  it("sets event deadline when all markets agree within one hour", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({ id: "1", groupItemTitle: "January 15, 2026", groupItemThreshold: 0 }),
        activeMarket({ id: "2", groupItemTitle: "January 15, 2026", groupItemThreshold: 1 }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.deadline).toBe("2026-01-16T04:59:59.999Z");
  });

  it("omits event deadline when market deadlines differ by more than one hour", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({ id: "1", groupItemTitle: "January 15, 2026", groupItemThreshold: 0 }),
        activeMarket({ id: "2", groupItemTitle: "February 15, 2026", groupItemThreshold: 1 }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.deadline).toBeNull();
    expect(event.markets?.[0].deadline).toBe("2026-01-16T04:59:59.999Z");
    expect(event.markets?.[1].deadline).toBe("2026-02-16T04:59:59.999Z");
  });

  it("falls back to market endDate when group item title is not parseable", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: "1",
          groupItemTitle: "Not a calendar title",
          endDate: "2026-06-01T12:00:00.000Z",
        }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.calendar).toBe(false);
    expect(event.deadline).toBe("2026-06-01T12:00:00Z");
    expect(event.markets?.[0].deadline).toBe("2026-06-01T12:00:00Z");
  });

  it("returns event with relevant=false when start date is missing", () => {
    const input: RawEvent = {
      id: eventId,
      markets: [activeMarket({ groupItemTitle: "January 15, 2026" })],
    };
    const event = toPostEvent(input);

    expect(event).toEqual({ ...input, relevant: false });
    expect(event.deadline).toBeUndefined();
  });

  it("returns event with relevant=false when calendar parsing fails", () => {
    const input: RawEvent = {
      id: eventId,
      startDate: "not-a-date",
      markets: [
        activeMarket({ id: "1", groupItemTitle: "March 15", groupItemThreshold: 0 }),
        activeMarket({ id: "2", groupItemTitle: "April 1", groupItemThreshold: 1 }),
      ],
    };
    const event = toPostEvent(input);

    expect(event.relevant).toBe(false);
    expect(event.deadline).toBeUndefined();
    expect(event.calendar).toBeUndefined();
    expect(event.markets?.[0].deadline).toBeUndefined();
  });

  it("includes only relevant markets in the output", () => {
    const event = toPostEvent({
      id: eventId,
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        { id: "1", active: true, groupItemTitle: "January 15, 2026" },
        activeMarket({ id: "2", groupItemTitle: "January 15, 2026" }),
      ],
    });

    expect(event.relevant).toBe(true);
    expect(event.calendar).toBe(true);
    expect(event.markets).toHaveLength(1);
    expect(event.markets?.[0].id).toBe("2");
    expect(event.markets?.[0].deadline).toBe("2026-01-16T04:59:59.999Z");
  });
});
