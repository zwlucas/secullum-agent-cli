/**
 * utils.js - Colors, formatting helpers, and shared utilities.
 * Uses raw ANSI escape codes so we have zero external dependencies.
 */

'use strict';

// ── ANSI colour helpers ────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function makeColor(code) {
  const fn = (s) => (s !== undefined ? `${ESC}${code}m${s}${RESET}` : `${ESC}${code}m`);
  fn.toString = () => `${ESC}${code}m`;
  fn[Symbol.toPrimitive] = () => `${ESC}${code}m`;
  return fn;
}

const color = {
  reset:     RESET,
  red:       makeColor('31'),
  green:     makeColor('32'),
  yellow:    makeColor('33'),
  blue:      makeColor('34'),
  magenta:   makeColor('35'),
  cyan:      makeColor('36'),
  white:     makeColor('37'),
  gray:      makeColor('90'),
  bold:      makeColor('1'),
  dim:       makeColor('2'),
  underline: makeColor('4'),
  bgRed:     makeColor('41'),
  bgGreen:   makeColor('42'),
  bgYellow:  makeColor('43'),
};

// ── Unicode symbols ────────────────────────────────────────────────
const symbols = {
  check:  '✓',
  cross:  '✗',
  bullet: '●',
  arrow:  '→',
  dash:   '─',
  pipe:   '│',
  corner: '└',
  tee:    '├',
};

// ── Status colouring helpers ───────────────────────────────────────

/**
 * Colour a boolean-ish status value.
 * @param {boolean} ok
 * @param {string}  [trueLabel='Connected']
 * @param {string}  [falseLabel='Disconnected']
 */
function statusLabel(ok, trueLabel = 'Connected', falseLabel = 'Disconnected') {
  return ok ? color.green(`${symbols.check} ${trueLabel}`) : color.red(`${symbols.cross} ${falseLabel}`);
}

/**
 * Colour a service-status string (Running / Stopped / StartPending …).
 */
function serviceStatusLabel(status) {
  const s = (status || '').toLowerCase().trim();
  if (s === 'running' || s === 'active') return color.green(`${symbols.bullet} Running`);
  if (s === 'stopped' || s === 'inactive') return color.red(`${symbols.bullet} Stopped`);
  if (s === 'startpending' || s === 'activating') return color.yellow(`${symbols.bullet} Starting…`);
  if (s === 'stoppending' || s === 'deactivating') return color.yellow(`${symbols.bullet} Stopping…`);
  if (s === 'failed') return color.red(`${symbols.cross} Failed`);
  return color.yellow(`${symbols.bullet} ${status || 'Unknown'}`);
}

/**
 * Map numeric server-connection status to a label.
 * 0 = disconnected, 1 = connected, 2 = connecting (inferred from app behaviour).
 */
function serverConnectionLabel(code) {
  switch (code) {
    case 0: return color.red(`${symbols.cross} Disconnected`);
    case 1: return color.green(`${symbols.check} Connected`);
    case 2: return color.yellow(`${symbols.bullet} Connecting…`);
    default: return color.yellow(`${symbols.bullet} Unknown (${code})`);
  }
}

// ── Table / layout helpers ─────────────────────────────────────────

/**
 * Pad/truncate a string to exactly `len` visible characters.
 * Accounts for ANSI escape sequences that don't occupy visual width.
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function padEnd(s, len) {
  const visible = stripAnsi(s).length;
  return visible >= len ? s : s + ' '.repeat(len - visible);
}

function padStart(s, len) {
  const visible = stripAnsi(s).length;
  return visible >= len ? s : ' '.repeat(len - visible) + s;
}

function printSection(title, rows = null) {
  console.log();
  console.log(color.bold(color.cyan(`  ${title}`)));
  console.log(color.dim(`  ${'─'.repeat(50)}`));
  if (Array.isArray(rows) && rows.length > 0) {
    const maxLabel = Math.max(...rows.map(([l]) => stripAnsi(l).length));
    for (const [label, value] of rows) {
      console.log(`  ${padEnd(label + ':', maxLabel + 1)}  ${value}`);
    }
  }
}

/**
 * Print a table with headers and rows.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function printTable(headers, rows) {
  // Compute column widths
  const cols = headers.length;
  const widths = headers.map((h) => stripAnsi(h).length);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      const w = stripAnsi(String(row[i] ?? '')).length;
      if (w > widths[i]) widths[i] = w;
    }
  }

  // Header
  const headerLine = headers.map((h, i) => padEnd(color.bold(h), widths[i])).join('  ');
  console.log(`  ${headerLine}`);
  console.log(`  ${widths.map((w) => '─'.repeat(w)).join('──')}`);

  // Rows
  for (const row of rows) {
    const line = row.map((cell, i) => padEnd(String(cell ?? ''), widths[i])).join('  ');
    console.log(`  ${line}`);
  }
}

/**
 * Clear the terminal screen (for monitor mode).
 */
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * Print an error message in red and exit.
 */
function fatal(msg) {
  console.error(color.red(`\n ${symbols.cross} ${msg}\n`));
  process.exit(1);
}

/**
 * Print a warning message.
 */
function warn(msg) {
  console.error(color.yellow(` ${symbols.bullet} ${msg}`));
}

/**
 * Print a success message.
 */
function success(msg) {
  console.log(color.green(` ${symbols.check} ${msg}`));
}

/**
 * Print an info message.
 */
function info(msg) {
  console.log(color.cyan(` ${symbols.bullet} ${msg}`));
}

function header(title) {
  console.log();
  console.log(color.bold(color.cyan(`  ${title}`)));
  console.log(color.dim(`  ${'─'.repeat(54)}`));
}

function keyValue(key, value) {
  console.log(`  ${color.dim(padEnd(key + ':', 22))} ${value}`);
}

function printErr(msg) {
  console.error(color.red(`  ${symbols.cross} ${msg}`));
}

module.exports = {
  color,
  colors: color,
  symbols,
  statusLabel,
  serviceStatusLabel,
  serverConnectionLabel,
  stripAnsi,
  padEnd,
  padStart,
  printSection,
  section: printSection,
  printTable,
  table: printTable,
  header,
  keyValue,
  clearScreen,
  fatal,
  warn,
  success,
  info,
  error: printErr,
};

