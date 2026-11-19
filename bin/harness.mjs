#!/usr/bin/env node
// The `harness` command. Node >= 22.18 runs the .ts sources directly (types stripped).
import { main } from "../src/cli.ts";
process.exitCode = await main(process.argv.slice(2));
