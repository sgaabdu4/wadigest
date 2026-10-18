#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n✖ ${err.message}`);
  if (process.env.WADIGEST_DEBUG) console.error(err.stack);
  process.exit(1);
});
