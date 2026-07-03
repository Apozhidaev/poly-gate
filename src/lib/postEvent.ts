/**
 * Adds `calendar` + `deadline` to a raw event and `deadline` to each nested market.
 */

import { Temporal, type Instant } from "./temporal.js";

export interface RawMarket {
  id: string;
  conditionId?: string;
  groupItemTitle?: string | null;
  groupItemThreshold?: number | null;
  endDate?: string | null;
  active?: boolean;
  archived?: boolean;
  closed?: boolean;
  [key: string]: unknown;
}

export interface RawEvent {
  id: string;
  startDate?: string | null;
  createdAt?: string | null;
  endDate?: string | null;
  markets?: RawMarket[];
  [key: string]: unknown;
}

interface Deadline {
  marketId: string;
  groupItemTitle: string;
  groupItemThreshold: number;
  month: number;
  day: number;
  year: number | null;
}

interface DeadlineResult {
  deadlineMap: Map<string, Instant>;
  calendarFilled: boolean;
  eventDeadline: Instant | null;
}

const POLYMARKET_TZ = "America/New_York";

const GROUP_TITLE_RE = /^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/;

const WEEKDAY_PREFIX_RE =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i;

const MONTH_FULL: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function normalizeGroupItemTitle(title: string): string {
  return title.trim().replace(WEEKDAY_PREFIX_RE, "");
}

function deadlineToInstant(dl: Deadline): Instant {
  if (dl.year === null) {
    throw new Error(`groupItemTitle '${dl.groupItemTitle}': year not set`);
  }
  return Temporal.ZonedDateTime.from({
    timeZone: POLYMARKET_TZ,
    year: dl.year,
    month: dl.month,
    day: dl.day,
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
  }).toInstant();
}

function parseInstant(iso: string): Instant | null {
  try {
    return Temporal.Instant.from(iso);
  } catch {
    return null;
  }
}

function deadlineFromGroupItem(market: RawMarket): Deadline | null {
  const originalTitle = market.groupItemTitle;
  const threshold = market.groupItemThreshold;

  if (!originalTitle) {
    return null;
  }
  if (threshold == null) {
    return null;
  }

  const title = normalizeGroupItemTitle(originalTitle);
  const m = GROUP_TITLE_RE.exec(title);
  if (!m) {
    return null;
  }

  const [, monthName, dayStr, yearStr] = m;
  const month =
    MONTH_FULL[monthName] ??
    MONTH_FULL[
      monthName.charAt(0).toUpperCase() + monthName.slice(1).toLowerCase()
    ];
  if (month === undefined) {
    return null;
  }
  const day = Number(dayStr);
  if (day < 1 || day > 31) {
    return null;
  }

  return {
    marketId: market.id,
    groupItemTitle: originalTitle,
    groupItemThreshold: threshold,
    month,
    day,
    year: yearStr !== undefined ? Number(yearStr) : null,
  };
}

function isDeadlinesFilled(deadlines: Deadline[]): boolean {
  return deadlines.every((deadline) => deadline.year !== null);
}

function isDeadlinesMonotonic(
  deadlines: Deadline[],
  permissibleDeviationDays = 100,
): boolean {
  const epochMs = deadlines.map((d) => deadlineToInstant(d).epochMilliseconds);
  const permissibleDelta = permissibleDeviationDays * DAY_MS;
  for (let i = 0; i < epochMs.length - 1; i++) {
    if (!(epochMs[i] - permissibleDelta < epochMs[i + 1])) {
      return false;
    }
  }
  return true;
}

/** Extract the literal year and month from the start of an ISO date string. */
function isoYearMonth(iso: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) {
    throw new Error(`invalid event start date: '${iso}'`);
  }
  return { year: Number(m[1]), month: Number(m[2]) };
}

function calendarFromGroupItems(
  markets: RawMarket[],
  eventStartDate: string,
): Deadline[] {
  const deadlines: Deadline[] = [];

  for (const market of markets) {
    const deadline = deadlineFromGroupItem(market);
    if (deadline === null) {
      continue;
    }
    deadlines.push(deadline);
  }

  if (deadlines.length === 0) {
    return deadlines;
  }

  deadlines.sort((a, b) => {
    if (a.groupItemThreshold !== b.groupItemThreshold) {
      return a.groupItemThreshold - b.groupItemThreshold;
    }
    if (a.month !== b.month) {
      return a.month - b.month;
    }
    return a.day - b.day;
  });

  if (isDeadlinesFilled(deadlines)) {
    return deadlines;
  }

  const eventStart = isoYearMonth(eventStartDate); // todo: should this be ZonedDateTime?

  const firstDeadline = deadlines[0];
  if (firstDeadline.year === null) {
    firstDeadline.year =
      firstDeadline.month >= eventStart.month
        ? eventStart.year
        : eventStart.year + 1;
  }

  for (let i = 0; i < deadlines.length - 1; i++) {
    const preDeadline = deadlines[i];
    const deadline = deadlines[i + 1];
    if (deadline.year === null) {
      deadline.year =
        deadline.month >= preDeadline.month
          ? (preDeadline.year as number)
          : (preDeadline.year as number) + 1;
    }
  }

  if (!isDeadlinesMonotonic(deadlines)) {
    throw new Error("deadlines are not monotonically increasing");
  }

  return deadlines;
}

function sameDeadline(
  deadlineMap: Map<string, Instant>,
  marketsCount: number,
): Instant | null {
  if (deadlineMap.size === 0) {
    return null;
  }
  if (marketsCount !== deadlineMap.size) {
    return null;
  }

  const epochMs = [...deadlineMap.values()].map((d) => d.epochMilliseconds);
  const maxDeadline = Math.max(...epochMs);
  const minDeadline = Math.min(...epochMs);
  if (maxDeadline - minDeadline > HOUR_MS) {
    return null;
  }
  return Temporal.Instant.fromEpochMilliseconds(maxDeadline);
}

function clarifyDeadlines(
  markets: RawMarket[],
  eventStartDate: string,
  eventEndDate: string | null,
): DeadlineResult {
  if (markets.length === 0) {
    throw new Error("no markets");
  }

  const deadlines = calendarFromGroupItems(markets, eventStartDate);
  const calendarMap = new Map<string, Instant>();
  for (const deadline of deadlines) {
    calendarMap.set(deadline.marketId, deadlineToInstant(deadline));
  }

  const deadlineMap = new Map<string, Instant>();
  for (const market of markets) {
    const id = market.id;
    const calendarDeadline = calendarMap.get(id);
    if (calendarDeadline !== undefined) {
      deadlineMap.set(id, calendarDeadline);
      continue;
    }
    const endDate = market.endDate || eventEndDate;
    if (endDate) {
      const instant = parseInstant(endDate);
      if (instant !== null) {
        deadlineMap.set(id, instant);
      }
    }
  }

  return {
    deadlineMap,
    calendarFilled: markets.length === deadlines.length,
    eventDeadline: sameDeadline(deadlineMap, markets.length),
  };
}

function marketRelevant(market: RawMarket): boolean {
  if (!market.id || !market.conditionId) {
    return false;
  }
  return (
    market.active === true ||
    (market.archived === true && market.closed === true)
  );
}

function toIso(instant: Instant | null | undefined): string | null {
  return instant ? instant.toString() : null;
}

/**
 * Add `calendar` + `deadline` to a raw event and `deadline` to each nested market.
 * Returns a shallow copy; nested markets are also copied.
 */
export function toPostEvent(event: RawEvent): RawEvent {
  const result: RawEvent = { ...event, relevant: false };
  if (!result.id) {
    return result;
  }

  const startDate = event.startDate || event.createdAt;

  if (!startDate) {
    return result;
  }

  const relevantMarkets = (event.markets ?? []).filter(marketRelevant);

  if (relevantMarkets.length === 0) {
    return result;
  }

  let deadlineResult: DeadlineResult;

  try {
    deadlineResult = clarifyDeadlines(
      relevantMarkets,
      startDate,
      event.endDate ?? null,
    );
  } catch {
    return result;
  }

  const { deadlineMap, calendarFilled, eventDeadline } = deadlineResult;

  result.relevant = true;
  result.calendar = calendarFilled;
  result.deadline = toIso(eventDeadline);

  result.markets = relevantMarkets.map((market) => {
    const item: RawMarket = { ...market };
    item.deadline = toIso(deadlineMap.get(market.id));
    return item;
  });

  return result;
}
