#!/usr/bin/env node

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PACKAGES = [
  "shared",
  "affinity-groups",
  "compute-resources",
  "system-status",
  "software-discovery",
  "events",
  "allocations",
  "nsf-awards",
  "announcements",
  "xdmod",
];

// documentation isn't published: it needs the server-side ACCESS_AI_API_KEY, so
// a local install can't search. Clients use the hosted server instead.

function runCommand(command, options = {}) {
  try {
    console.log(`📦 Running: ${command}`);
    const result = execSync(command, {
      stdio: "inherit",
      encoding: "utf8",
      ...options,
    });
    return result;
  } catch (error) {
    console.error(`❌ Command failed: ${command}`);
    console.error(error.message);

    // Check for OTP-related errors
    if (error.message.includes("EOTP") || error.message.includes("one-time password")) {
      console.error(
        "\n💡 Tip: OTP may have expired. Please run the script again with a fresh OTP."
      );
      console.error("   You can also publish individual packages manually:");
      console.error("   cd packages/<package-name> && npm publish --access public --otp=<code>");
    }

    process.exit(1);
  }
}

function checkPackage(packageName) {
  const packagePath = join("packages", packageName);
  const packageJsonPath = join(packagePath, "package.json");
  const distPath = join(packagePath, "dist");
  const readmePath = join(packagePath, "README.md");

  console.log(`\n🔍 Checking package: @access-mcp/${packageName}`);

  // Check package.json exists
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found for ${packageName}`);
  }

  // Check dist folder exists
  if (!existsSync(distPath)) {
    throw new Error(`dist folder not found for ${packageName}. Run 'npm run build' first.`);
  }

  // Check README exists
  if (!existsSync(readmePath)) {
    console.warn(`⚠️  README.md not found for ${packageName}. Consider adding one.`);
  }

  // Parse package.json
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  // Check required fields
  const requiredFields = ["name", "version", "description", "main", "author", "license"];
  for (const field of requiredFields) {
    if (!packageJson[field]) {
      throw new Error(`Missing required field '${field}' in ${packageName}/package.json`);
    }
  }

  console.log(`✅ Package ${packageName} looks good!`);
  return packageJson;
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const skipShared = process.argv.includes("--skip-shared");

  const publishCommand = isDryRun
    ? "npm publish --dry-run --access public"
    : "npm publish --access public";

  console.log("🚀 ACCESS-CI MCP Packages Publisher");
  console.log(`📋 Mode: ${isDryRun ? "DRY RUN" : "LIVE PUBLISH"}`);
  if (skipShared) console.log("⚠️  Skipping shared package (--skip-shared)");
  console.log("");

  // Pre-publish checks
  console.log("🔍 Running pre-publish checks...");

  // Build all packages
  runCommand("npm run build");

  // Run tests
  console.log("🧪 Running tests...");
  runCommand("npm test");

  // Check each package
  for (const packageName of PACKAGES) {
    checkPackage(packageName);
  }

  console.log("\n✅ All pre-publish checks passed!");

  if (isDryRun) {
    console.log("\n🎭 Running dry-run publish...");
    runCommand("npm publish --dry-run --workspaces --access public");
  } else {
    console.log("\n🚀 Publishing packages to npm...");

    // Publish all packages, shared first (others depend on it)
    const orderedPackages = skipShared ? PACKAGES.slice(1) : PACKAGES;
    let publishedCount = 0;
    let skippedCount = 0;

    for (const packageName of orderedPackages) {
      const packageJson = JSON.parse(
        readFileSync(join("packages", packageName, "package.json"), "utf8")
      );
      const localVersion = packageJson.version;
      const npmName = packageJson.name;

      // Check if this version is already published
      try {
        const npmVersion = execSync(`npm view ${npmName} version 2>/dev/null`, {
          encoding: "utf8",
        }).trim();
        if (npmVersion === localVersion) {
          console.log(`\n⏭️  ${packageName}@${localVersion} already published, skipping`);
          skippedCount++;
          continue;
        }
      } catch {
        // Package not on npm yet, proceed with publish
      }

      console.log(`\n📦 Publishing ${packageName}@${localVersion}...`);
      try {
        execSync("npm publish --access public", {
          stdio: "inherit",
          encoding: "utf8",
          cwd: `packages/${packageName}`,
        });
        console.log(`✅ ${packageName}@${localVersion} published successfully!`);
        publishedCount++;

        // Wait for npm to propagate after shared (others depend on it)
        if (packageName === "shared") {
          console.log("⏳ Waiting for npm to propagate shared package...");
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      } catch (error) {
        console.error(`❌ Failed to publish ${packageName}:`, error.message);
        if (error.message.includes("EOTP") || error.message.includes("one-time password")) {
          console.error("💡 OTP may have expired. You can publish this package manually:");
          console.error(
            `   cd packages/${packageName} && npm publish --access public --otp=<code>`
          );
        }
        console.error("Continuing with remaining packages...");
      }
    }

    console.log(`\n📊 Published: ${publishedCount}, Skipped: ${skippedCount}`);
  }

  console.log("\n🎉 Publishing complete!");
  console.log("\n📖 Next steps:");
  console.log("1. Verify packages on npmjs.com");
  console.log("2. Test installation: npm install -g @access-mcp/affinity-groups");
  console.log("3. Update documentation with installation instructions");
  console.log("\n💡 Usage options:");
  console.log("  --dry-run     : Test publish without actually publishing");
  console.log("  --skip-shared : Skip publishing the shared package");
}

main().catch((error) => {
  console.error("\n❌ Publishing failed:", error.message);
  process.exit(1);
});
