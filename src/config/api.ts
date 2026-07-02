export type Api = "gamma" | "data" | "clob" | "pnl";

export const API_NAMES = ["gamma", "data", "clob", "pnl"] as const satisfies readonly Api[];
