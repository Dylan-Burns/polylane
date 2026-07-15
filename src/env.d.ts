export interface Env {
  DB: D1Database;
  SIMULATOR: DurableObjectNamespace;
  INVESTIGATOR: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  MODEL_ID: string;
}
