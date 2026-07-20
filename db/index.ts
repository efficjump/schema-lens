import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  const database = (env as { DB?: Parameters<typeof drizzle>[0] }).DB;
  if (!database) {
    throw new Error(
      "D1 binding `DB` is unavailable. Configure the runtime binding or let the deployment control plane inject it before using the database."
    );
  }

  return drizzle(database, { schema });
}
