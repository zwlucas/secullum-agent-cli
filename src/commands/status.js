/**
 * commands/status.js - Standalone Agent Status Dashboard.
 * Displays local machine details, Secullum Cloud session, active database,
 * equipment metrics, and direct cloud API connectivity.
 * Zero external dependencies.
 */

'use strict';

const os = require('node:os');
const { loadSession, getSessionFilePath, getAddedEquipmentIds } = require('../session');
const { getServerTime, listEquipments } = require('../pontoweb');
const { getPrimaryMacAddress } = require('../realtime');
const {
  colors,
  symbols,
  header,
  section,
  keyValue,
  success,
  warn,
  info,
} = require('../utils');

async function statusCommand() {
  header('Secullum RH — Standalone Agent Dashboard');

  // 1. Agent Machine Info
  section('Machine Details');
  keyValue('Host Name', os.hostname());
  keyValue('Platform', `${os.type()} ${os.release()} (${os.arch()})`);
  keyValue('Node.js', process.version);
  keyValue('MAC Address', getPrimaryMacAddress());

  // 2. Cloud Session Info
  const session = loadSession();
  section('Cloud Authentication');

  if (!session || !session.accessToken) {
    warn('No active cloud session found.');
    info('Run: secullum-agent-cli login');
    console.log();
    return;
  }

  keyValue('Account (E-mail)', session.usuario || 'Unknown');
  keyValue('Session File', getSessionFilePath());

  if (session.expiresAt) {
    const expiresDate = new Date(session.expiresAt);
    const diffMin = Math.round((session.expiresAt - Date.now()) / 60000);
    const statusText =
      diffMin > 0
        ? `${expiresDate.toLocaleString()} (${diffMin} min remaining)`
        : `${expiresDate.toLocaleString()} (EXPIRED - will auto-refresh)`;
    keyValue('Token Status', diffMin > 0 ? `${colors.green}${symbols.check} Valid${colors.reset} — ${statusText}` : `${colors.yellow}${symbols.bullet} ${statusText}${colors.reset}`);
  }

  // 3. Active Company Database
  section('Active Company Database');
  const banco = session.bancoSelecionado;
  if (banco) {
    keyValue('Company Name', colors.bold(banco.Descricao || banco.Nome || 'N/A'));
    keyValue('Database GUID', banco.Identificador);
    if (banco.CnpjCpf) keyValue('CNPJ / CPF', banco.CnpjCpf);
  } else {
    warn('No company database selected. Run: secullum-agent-cli databases');
  }

  // 4. Equipment Metrics & Direct Cloud Test
  section('Cloud API & Equipment');
  try {
    process.stdout.write(`${colors.dim}Checking PontoWeb cloud connectivity...${colors.reset}\r`);
    const srvTime = await getServerTime();
    const cloudEquips = await listEquipments().catch(() => []);
    const addedIds = getAddedEquipmentIds();

    success(`Cloud REST API connected (Server time: ${srvTime.data || 'OK'})`);
    keyValue('Total in Cloud', `${cloudEquips.length} equipment registered`);
    keyValue('Active on Agent', `${colors.bold(String(addedIds.length))} equipment enabled`);

    if (addedIds.length > 0) {
      keyValue('Active IDs', addedIds.join(', '));
    }
  } catch (err) {
    warn(`Cloud API query: ${err.message}`);
  }

  console.log(`\n${colors.dim}Run 'secullum-agent-cli connect' to start the live RealTime WebSocket agent.${colors.reset}\n`);
}

module.exports = { statusCommand };
