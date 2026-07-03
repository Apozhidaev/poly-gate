import { describe, expect, it } from "vitest";
import { mapToEventWithDeadline, type RawEvent } from "../src/lib/deadline.js";

const activeMarket = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  conditionId: "0xabc",
  active: true,
  groupItemThreshold: 0,
  ...overrides,
});

describe("mapToEventWithDeadline", () => {
  it("maps Polymarket deadline to end of calendar day in America/New_York (winter EST)", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: 1,
          groupItemTitle: "January 15, 2026",
        }),
      ],
    });

    expect(event.calendar).toBe(true);
    expect(event.deadline).toBe("2026-01-16T04:59:59.999Z");
    expect(event.markets?.[0].deadline).toBe("2026-01-16T04:59:59.999Z");
  });

  it("maps Polymarket deadline to end of calendar day in America/New_York (summer EDT)", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-07-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: 1,
          groupItemTitle: "July 15, 2026",
        }),
      ],
    });

    expect(event.deadline).toBe("2026-07-16T03:59:59.999Z");
    expect(event.markets?.[0].deadline).toBe("2026-07-16T03:59:59.999Z");
  });

  it("backfills missing years from event start date", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-03-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: 1,
          groupItemTitle: "March 15",
          groupItemThreshold: 0,
        }),
        activeMarket({
          id: 2,
          groupItemTitle: "April 1",
          groupItemThreshold: 1,
        }),
      ],
    });

    expect(event.calendar).toBe(true);
    expect(event.markets?.[0].deadline).toBe("2026-03-16T03:59:59.999Z");
    expect(event.markets?.[1].deadline).toBe("2026-04-02T03:59:59.999Z");
  });

  it("sets event deadline when all markets agree within one hour", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({ id: 1, groupItemTitle: "January 15, 2026", groupItemThreshold: 0 }),
        activeMarket({ id: 2, groupItemTitle: "January 15, 2026", groupItemThreshold: 1 }),
      ],
    });

    expect(event.deadline).toBe("2026-01-16T04:59:59.999Z");
  });

  it("omits event deadline when market deadlines differ by more than one hour", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({ id: 1, groupItemTitle: "January 15, 2026", groupItemThreshold: 0 }),
        activeMarket({ id: 2, groupItemTitle: "February 15, 2026", groupItemThreshold: 1 }),
      ],
    });

    expect(event.deadline).toBeNull();
    expect(event.markets?.[0].deadline).toBe("2026-01-16T04:59:59.999Z");
    expect(event.markets?.[1].deadline).toBe("2026-02-16T04:59:59.999Z");
  });

  it("falls back to market endDate when group item title is not parseable", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        activeMarket({
          id: 1,
          groupItemTitle: "Not a calendar title",
          endDate: "2026-06-01T12:00:00.000Z",
        }),
      ],
    });

    expect(event.calendar).toBe(false);
    expect(event.deadline).toBe("2026-06-01T12:00:00Z");
    expect(event.markets?.[0].deadline).toBe("2026-06-01T12:00:00Z");
  });

  it("returns event unchanged when start date is missing", () => {
    const input: RawEvent = {
      markets: [activeMarket({ groupItemTitle: "January 15, 2026" })],
    };
    const event = mapToEventWithDeadline(input);

    expect(event).toEqual(input);
    expect(event.deadline).toBeUndefined();
  });

  it("returns event unchanged when calendar parsing fails", () => {
    const input: RawEvent = {
      startDate: "not-a-date",
      markets: [
        activeMarket({ id: 1, groupItemTitle: "March 15", groupItemThreshold: 0 }),
        activeMarket({ id: 2, groupItemTitle: "April 1", groupItemThreshold: 1 }),
      ],
    };
    const event = mapToEventWithDeadline(input);

    expect(event.deadline).toBeUndefined();
    expect(event.calendar).toBeUndefined();
    expect(event.markets?.[0].deadline).toBeUndefined();
  });

  it("skips markets without conditionId", () => {
    const event = mapToEventWithDeadline({
      startDate: "2026-01-01T00:00:00.000Z",
      markets: [
        { id: 1, active: true, groupItemTitle: "January 15, 2026" },
        activeMarket({ id: 2, groupItemTitle: "January 15, 2026" }),
      ],
    });

    expect(event.calendar).toBe(true);
    expect(event.markets?.[0].deadline).toBeNull();
    expect(event.markets?.[1].deadline).toBe("2026-01-16T04:59:59.999Z");
  });
});
