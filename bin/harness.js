#!/usr/bin/env node
// The `harness` command as installed from the package: the compiled sources (dist/). In this repository,
// bin/harness.mjs runs the .ts sources directly.
import { main } from "../dist/cli.js";
process.exitCode = await main(process.argv.slice(2));
