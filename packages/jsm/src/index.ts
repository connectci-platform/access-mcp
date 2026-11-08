#!/usr/bin/env node

import { JsmServer } from "./server.js";

async function main() {
  const server = new JsmServer();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  await server.start(port ? { httpPort: port } : undefined);
}

main().catch((error) => {
  console.error("Server error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
