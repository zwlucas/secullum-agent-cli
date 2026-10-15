/**
 * commands/time.js - Query Secullum Cloud server time and compute clock drift.
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.exe:
 *   - GET https://pontoweb.secullum.com.br/Equipamentos/ObterDataHoraServidor/{fusoHorarioId}
 * Zero external dependencies.
 */

'use strict';

const { getServerTime } = require('../pontoweb');
const { loadSession } = require('../session');
const {
  colors,
  symbols,
  header,
  section,
  keyValue,
  success,
  error: printError,
} = require('../utils');

async function timeCommand(args = []) {
  header('Secullum Cloud — Server Clock Synchronization');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('No active session. Please run: secullum-agent-cli login');
    process.exit(1);
  }

  const fusoId = Number(args[0]) || 22;
  const t0 = Date.now();

  try {
    process.stdout.write(`${colors.dim}Querying Secullum Cloud server clock...${colors.reset}\r`);
    const res = await getServerTime(fusoId);
    const roundtrip = Date.now() - t0;

    const serverDateStr = res.data || res.Data || res;
    const serverDate = new Date(serverDateStr);
    const localDate = new Date();

    const driftMs = Math.abs(serverDate.getTime() - localDate.getTime());

    section('Clock Information');
    keyValue('Cloud Server Time', colors.bold(colors.cyan(serverDate.toLocaleString())));
    keyValue('Local System Time', localDate.toLocaleString());
    keyValue('Roundtrip Latency', `${roundtrip} ms`);

    if (driftMs < 2000) {
      success(`System clock is accurately synchronized (drift: ${driftMs}ms).`);
    } else {
      keyValue('Clock Drift', `${colors.yellow}${symbols.bullet} ${Math.round(driftMs / 1000)} seconds difference${colors.reset}`);
    }
  } catch (err) {
    printError(`Failed to retrieve server time: ${err.message}`);
    process.exit(1);
  }

  console.log();
}

module.exports = { timeCommand };
