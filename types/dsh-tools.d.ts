// Minimal ambient types for the DSH host-provided peer dependency.
// The real module is supplied by DeepSeek Harness at runtime.
declare module "@deepseek-ai/dsh-tools" {
  export interface ToolDefinition {
    name: string;
    description?: string;
    parameters?: unknown;
    isConcurrencySafe?: boolean;
    execute: (args: any, extra: any) => unknown;
    [key: string]: unknown;
  }
  export function defineTool(definition: ToolDefinition): ToolDefinition;
}
