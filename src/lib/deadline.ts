/**
 * Adds `calendar` + `deadline` to a raw event and `deadline` to each nested market.
 */

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export interface RawMarket {
  id?: number | string;
  conditionId?: string;
  condition_id?: string;
  groupItemTitle?: string | null;
  groupItemThreshold?: number | null;
  endDate?: string | null;
  active?: boolean;
  archived?: boolean;
  closed?: boolean;
  [key: string]: unknown;
}

export interface RawEvent {
  id?: number | string;
  startDate?: string | null;
  createdAt?: string | null;
  endDate?: string | null;
  markets?: RawMarket[];
  [key: string]: unknown;
}

export interface Deadline {
  marketId: number;
  groupItemTitle: string;
  groupItemThreshold: number;
  month: number;
  day: number;
  year: number | null;
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

/**
 * Convert a wall-clock time in the given IANA timezone to the corresponding UTC instant.
 * DST-aware via `Intl.DateTimeFormat`.
 */
function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(new Date(asUtc));
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = Number(part.value);
    }
  }

  const partsAsUtc = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    map.hour,
    map.minute,
    map.second,
  );

  const offset = partsAsUtc - Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(asUtc - offset);
}

function toPolymarketDeadline(year: number, month: number, day: number): Date {
  return zonedWallTimeToUtc(year, month, day, 23, 59, 59, 999, POLYMARKET_TZ);
}

function normalizeGroupItemTitle(title: string): string {
  return title.trim().replace(WEEKDAY_PREFIX_RE, "");
}

function parseId(v: number | string): number {
  return typeof v === "number" ? v : parseInt(v, 10);
}

function marketId(market: RawMarket): number | null {
  if (market.id === undefined || market.id === null) {
    return null;
  }
  return parseId(market.id);
}

function deadlineToDate(dl: Deadline): Date {
  if (dl.year === null) {
    throw new ContractError(
      `group_item_title '${dl.groupItemTitle}': year not set`,
    );
  }
  const date = toPolymarketDeadline(dl.year, dl.month, dl.day);
  if (Number.isNaN(date.getTime())) {
    throw new ContractError(
      `group_item_title '${dl.groupItemTitle}': invalid date`,
    );
  }
  return date;
}

function deadlineFromGroupItem(market: RawMarket): Deadline | null {
  const id = marketId(market);
  const originalTitle = market.groupItemTitle;
  const threshold = market.groupItemThreshold;

  if (id === null) {
    return null;
  }
  if (!originalTitle) {
    return null;
  }
  if (threshold === undefined || threshold === null) {
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
    MONTH_FULL[monthName.charAt(0).toUpperCase() + monthName.slice(1).toLowerCase()];
  if (month === undefined) {
    return null;
  }
  const day = parseInt(dayStr, 10);
  if (day < 1 || day > 31) {
    return null;
  }

  return {
    marketId: id,
    groupItemTitle: originalTitle,
    groupItemThreshold: threshold,
    month,
    day,
    year: yearStr !== undefined ? parseInt(yearStr, 10) : null,
  };
}

function isDeadlinesFilled(deadlines: Deadline[]): boolean {
  return deadlines.every((deadline) => deadline.year !== null);
}

function isDeadlinesMonotonic(
  deadlines: Deadline[],
  permissibleDeviationDays = 100,
): boolean {
  const dates = deadlines.map((d) => deadlineToDate(d).getTime());
  const permissibleDelta = permissibleDeviationDays * DAY_MS;
  for (let i = 0; i < dates.length - 1; i++) {
    if (!(dates[i] - permissibleDelta < dates[i + 1])) {
      return false;
    }
  }
  return true;
}

/** Extract the literal year and month from the start of an ISO date string. */
function isoYearMonth(iso: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) {
    throw new ContractError(`invalid event start date: '${iso}'`);
  }
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
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

  const eventStart = isoYearMonth(eventStartDate);

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
    throw new ContractError("deadlines are not monotonically increasing");
  }

  return deadlines;
}

function sameDeadline(
  deadlineMap: Map<number, Date>,
  marketsCount: number,
): Date | null {
  if (deadlineMap.size === 0) {
    return null;
  }
  if (marketsCount !== deadlineMap.size) {
    return null;
  }

  const times = [...deadlineMap.values()].map((d) => d.getTime());
  const maxDeadline = Math.max(...times);
  const minDeadline = Math.min(...times);
  if (maxDeadline - minDeadline > HOUR_MS) {
    return null;
  }
  return new Date(maxDeadline);
}

interface DeadlineMapResult {
  deadlineMap: Map<number, Date>;
  calendarFilled: boolean;
  sameDeadline: Date | null;
}

function getDeadlineMapForMarkets(
  markets: RawMarket[],
  eventStartDate: string,
  eventEndDate: string | null,
): DeadlineMapResult {
  if (markets.length === 0) {
    return { deadlineMap: new Map(), calendarFilled: false, sameDeadline: null };
  }

  const deadlines = calendarFromGroupItems(markets, eventStartDate);
  const calendarMap = new Map<number, Date>();
  for (const deadline of deadlines) {
    calendarMap.set(deadline.marketId, deadlineToDate(deadline));
  }

  const deadlineMap = new Map<number, Date>();
  for (const market of markets) {
    const id = marketId(market);
    if (id === null) {
      continue;
    }
    const calendarDeadline = calendarMap.get(id);
    if (calendarDeadline !== undefined) {
      deadlineMap.set(id, calendarDeadline);
      continue;
    }
    const endDate = market.endDate || eventEndDate;
    if (endDate) {
      deadlineMap.set(id, new Date(endDate));
    }
  }

  const marketsCount = markets.length;
  return {
    deadlineMap,
    calendarFilled: marketsCount === deadlines.length,
    sameDeadline: sameDeadline(deadlineMap, marketsCount),
  };
}

function marketRelevant(market: RawMarket): boolean {
  return (
    market.active === true ||
    (market.archived === true && market.closed === true)
  );
}

function hasConditionId(market: RawMarket): boolean {
  return Boolean(market.conditionId || market.condition_id);
}

function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/**
 * Add `calendar` + `deadline` to a raw event and `deadline` to each nested market.
 * Returns a shallow copy; nested markets are also copied.
 */
export function mapToEventWithDeadline(event: RawEvent): RawEvent {
  const result: RawEvent = { ...event };

  const marketsRaw = event.markets ?? [];
  const markets = marketsRaw.filter(hasConditionId);
  const relevantMarkets = markets.filter(marketRelevant);

  // Only actually parsed when calendar year backfill is needed (see isoYearMonth).
  const startDate = event.startDate || event.createdAt || "";

  const { deadlineMap, calendarFilled, sameDeadline: same } =
    getDeadlineMapForMarkets(relevantMarkets, startDate, event.endDate ?? null);

  result.calendar = calendarFilled;
  result.deadline = toIso(same);

  if (marketsRaw.length > 0) {
    result.markets = marketsRaw.map((raw) => {
      const item: RawMarket = { ...raw };
      const id = marketId(raw);
      if (id !== null) {
        item.deadline = toIso(deadlineMap.get(id));
      }
      return item;
    });
  }

  return result;
}
