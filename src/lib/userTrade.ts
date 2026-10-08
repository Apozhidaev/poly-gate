export type Side = "BUY" | "SELL";

type Json = Record<string, unknown>;

export interface UserTrade {
  tradeId: string;
  orderId: string;
  conditionId: string;
  assetId: string;
  avgPrice: number;
  matchedAmount: number;
  side: Side;
  matchTime: number;
}


function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseMatchTime(trade: Json): number {
  const matchedAt = trade["matchedAt"];
  if (typeof matchedAt !== "string" || matchedAt === "") return 0;
  const ms = Date.parse(matchedAt);
  return Number.isFinite(ms) ? ms : 0;
}

function parseTaker(trade: Json): UserTrade {
  return {
    tradeId: asString(trade["id"]),
    orderId: asString(trade["takerOrderId"]),
    assetId: asString(trade["assetId"]),
    conditionId: asString(trade["conditionId"]),
    avgPrice: Number(trade["price"]),
    matchedAmount: Number(trade["size"]),
    side: trade["side"] as Side,
    matchTime: parseMatchTime(trade),
  };
}

function parseMaker(order: Json, trade: Json): UserTrade {
  return {
    tradeId: asString(trade["id"]),
    orderId: asString(order["orderId"]),
    assetId: asString(order["assetId"]),
    conditionId: asString(trade["conditionId"]),
    avgPrice: Number(order["price"]),
    matchedAmount: Number(order["matchedAmount"]),
    side: order["side"] as Side,
    matchTime: parseMatchTime(trade),
  };
}

function parseMakers(trade: Json, apiKey: string): UserTrade[] {
  const makerOrders = trade["makerOrders"];
  if (!Array.isArray(makerOrders)) return [];
  return (makerOrders as Json[])
    .filter((o) => o["owner"] === apiKey)
    .map((o) => parseMaker(o, trade));
}

export function parseTrades(trade: Json, apiKey: string): UserTrade[] {
  if (trade["traderSide"] === "TAKER") return [parseTaker(trade)];
  return parseMakers(trade, apiKey);
}
