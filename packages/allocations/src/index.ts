#!/usr/bin/env node

import { AllocationsServer } from "./server.js";

async function main() {
  const server = new AllocationsServer();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  await server.start(port ? { httpPort: port } : undefined);
}

main().catch((error) => {
  // Log errors to stderr and exit
  console.error("Server error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
