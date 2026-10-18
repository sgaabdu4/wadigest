import fs from 'node:fs';
import { paths } from './config.js';

let toConsole = true;

export function setConsoleLogging(on) {
  toConsole = on;
}

function write(level, msg) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  try {
    fs.mkdirSync(paths().logs, { recursive: true });
    fs.appendFileSync(paths().log, line + '\n');
  } catch { /* logging must never crash the app */ }
  if (toConsole && level !== 'DEBUG') {
    (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(msg);
  }
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  debug: (m) => write('DEBUG', m),
};
