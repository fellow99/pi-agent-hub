export class PluginError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

export function toPluginError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return new PluginError(typeof code === "string" ? code : "internal", error.message);
  }
  return new PluginError("internal", String(error));
}
