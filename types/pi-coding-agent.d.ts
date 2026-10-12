// Dev-only ambient stub for the pi coding-agent extension API (F020).
//
// index.ts imports three types from "@earendil-works/pi-coding-agent"; the real
// package ships its own declarations but is not resolvable from this repo, so
// `tsc --noEmit` reported TS2307 for it. This stub declares ONLY the surface
// index.ts actually uses. It is never loaded at runtime (pi supplies the real
// module) and must not grow a paths mapping or a runtime dependency.

declare module "@earendil-works/pi-coding-agent" {
  type NotifyLevel = "info" | "warning" | "error";

  export interface ExtensionUI {
    notify(message: string, level?: NotifyLevel): void;
  }

  export interface ExtensionContext {
    hasUI?: boolean;
    ui: ExtensionUI;
  }

  export interface ExtensionCommandContext {
    hasUI?: boolean;
    ui: ExtensionUI;
  }

  export interface ToolResult {
    content: Array<{ type: string; text: string }>;
  }

  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(
      toolCallId: string,
      params: { hash?: string },
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<ToolResult>;
  }

  export interface CommandDefinition {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
  }

  export interface ProviderDefinition {
    baseUrl: string;
    headers?: Record<string, string>;
  }

  export interface ExtensionAPI {
    registerCommand(name: string, definition: CommandDefinition): void;
    registerTool(definition: ToolDefinition): void;
    registerProvider(id: string, definition: ProviderDefinition): void;
    unregisterProvider(id: string): void;
    setActiveTools(tools: string[]): void;
    getActiveTools(): string[];
    on(
      event: string,
      handler: (event: unknown, ctx?: ExtensionContext) => void | Promise<void>,
    ): void;
  }
}
