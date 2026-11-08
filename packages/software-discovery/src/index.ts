#!/usr/bin/env node

import { SoftwareDiscoveryServer } from "./server.js";

async function main() {
  const server = new SoftwareDiscoveryServer();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  await server.start(port ? { httpPort: port } : undefined);
}

main().catch((error) => {
  console.error("Server error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
