export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure;

export function isRequest(value: unknown): value is JsonRpcRequest {
  return typeof value === "object" && value !== null
    && (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (value as { method?: unknown }).method === "string";
}

export function isResponse(value: unknown): value is JsonRpcSuccess | JsonRpcFailure {
  return typeof value === "object" && value !== null
    && (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && ("result" in value || "error" in value);
}

export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}
