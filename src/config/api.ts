export type Api = "gamma" | "data" | "clob";

export const API_NAMES = ["gamma", "data", "clob"] as const satisfies readonly Api[];
