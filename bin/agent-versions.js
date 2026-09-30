#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((err) => {
  console.error(`agent-versions: ${err.message}`);
  process.exitCode = 2;
});
