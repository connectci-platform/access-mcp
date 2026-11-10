import express from "express";
import path from "path";

export function startWebServer(port: number = 3000) {
  const app = express();

  // Serve static files from public directory
  const publicDir = path.join(__dirname, "../../../public");
  app.use(express.static(publicDir));

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "access-mcp-compute-resources" });
  });

  // API endpoint to list tools (for documentation)
  app.get("/api/tools", (req, res) => {
    res.json({
      server: "ACCESS-CI Compute Resources MCP Server",
      version: "0.3.0",
      tools: [
        {
          name: "search_resources",
          description: "Find ACCESS resources by name, hardware, datasets or access method",
        },
        {
          name: "get_resource",
          description: "Get a resource's documented login, storage, queue and support details",
        },
        {
          name: "compare_resources",
          description: "Compare two or three resources from their documentation",
        },
      ],
      resources: [
        {
          uri: "accessci://compute-resources",
          name: "ACCESS-CI Compute Resources",
          description: "Information about ACCESS-CI compute resources, hardware, and software",
        },
      ],
    });
  });

  // Start server
  app.listen(port, () => {
    console.log(`ACCESS-CI Compute Resources web server running on port ${port}`);
  });
}
