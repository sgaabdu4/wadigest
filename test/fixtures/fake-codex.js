#!/usr/bin/env node
import fs from 'node:fs';

process.stdin.resume();
process.stdin.on('end', () => {
  const index = process.argv.indexOf('-o');
  if (index < 0) process.exit(1);
  fs.writeFileSync(process.argv[index + 1], process.env.FAKE_CODEX_OUTPUT || '');
});
