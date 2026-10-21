#!/usr/bin/env node
// Node 24+ runs TypeScript directly (type stripping), so there is no build step.
await import("../src/cli.ts");
