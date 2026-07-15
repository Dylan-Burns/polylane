export interface Env {
  DB: D1Database;
  SIMULATOR: DurableObjectNamespace;
  INVESTIGATOR: DurableObjectNamespace;
  ANTHROPIC_API_KEY: string;
  MODEL_ID: string;
  /** Global traffic-rate multiplier applied on top of the generator's baseline 1.5 req/s peak
   * (wrangler.jsonc var, string per Workers' `vars` convention — parsed where consumed). */
  SIM_RATE: string;
}
