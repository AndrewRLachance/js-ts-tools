declare module "@opencode-ai/plugin" {
  export const tool: {
    (definition: {
      description: string;
      args: Record<string, unknown>;
      execute(args: any, context: any): string | Promise<string>;
    }): unknown;
    schema: any;
  };
}
