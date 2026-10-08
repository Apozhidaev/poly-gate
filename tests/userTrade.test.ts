import { describe, expect, it } from "vitest";
import { parseTrades } from "../src/lib/userTrade.js";

const API_KEY = "0623855e-28bf-b955-b8cd-a77427274647";
const OTHER_KEY = "02d10472-a028-a03c-6b71-03a8cd72443e";

const baseTrade = {
  id: "d83cf884-38cd-460c-97f7-4a1a8c6b971f",
  conditionId: "0xfdfdcbcf9c268407faefe9f0b29743f2aa6e701c5873bba02d87b206b8f9ae2e",
  assetId: "13746535053591566747844631539975609003059990422143780703172111994120738569717",
  price: "0.83",
  size: "13.09",
  side: "BUY",
  matchedAt: "2026-09-21T23:50:45.000Z",
  takerOrderId: "0x9d21164cef3cd6fddb9bd3e3d93f4f79ad6892545625773c87e8de334e84aad7",
};

describe("parseTrades", () => {
  it("maps a TAKER trade to a single UserTrade", () => {
    const rows = parseTrades({ ...baseTrade, traderSide: "TAKER", makerOrders: [] }, API_KEY);

    expect(rows).toEqual([
      {
        tradeId: baseTrade.id,
        orderId: baseTrade.takerOrderId,
        conditionId: baseTrade.conditionId,
        assetId: baseTrade.assetId,
        avgPrice: 0.83,
        matchedAmount: 13.09,
        side: "BUY",
        matchTime: Date.parse(baseTrade.matchedAt),
      },
    ]);
  });

  it("maps MAKER trades only for makerOrders owned by apiKey", () => {
    const rows = parseTrades(
      {
        ...baseTrade,
        traderSide: "MAKER",
        makerOrders: [
          {
            owner: OTHER_KEY,
            orderId: "0xother",
            assetId: baseTrade.assetId,
            price: "0.80",
            matchedAmount: "5",
            side: "SELL",
          },
          {
            owner: API_KEY,
            orderId: "0xmine",
            assetId: baseTrade.assetId,
            price: "0.82",
            matchedAmount: "8.09",
            side: "SELL",
          },
        ],
      },
      API_KEY,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      tradeId: baseTrade.id,
      orderId: "0xmine",
      conditionId: baseTrade.conditionId,
      assetId: baseTrade.assetId,
      avgPrice: 0.82,
      matchedAmount: 8.09,
      side: "SELL",
      matchTime: Date.parse(baseTrade.matchedAt),
    });
  });

  it("returns no rows for MAKER trades with no matching owner", () => {
    const rows = parseTrades(
      {
        ...baseTrade,
        traderSide: "MAKER",
        makerOrders: [
          {
            owner: OTHER_KEY,
            orderId: "0xother",
            assetId: baseTrade.assetId,
            price: "0.80",
            matchedAmount: "5",
            side: "SELL",
          },
        ],
      },
      API_KEY,
    );

    expect(rows).toEqual([]);
  });
});
