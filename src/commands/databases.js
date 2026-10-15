/**
 * commands/databases.js - List and select company databases from Secullum Cloud.
 * Zero external dependencies.
 */

'use strict';

const { listDatabases } = require('../auth');
const { loadSession, saveSession } = require('../session');
const {
  colors,
  symbols,
  header,
  table,
  success,
  error: printError,
} = require('../utils');

/**
 * databases command - List all company databases or switch active database.
 * @param {string[]} [args=[]]
 */
async function databasesCommand(args = []) {
  header('Secullum Cloud - Company Databases');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('No active session. Please run: secullum-agent-cli login');
    process.exit(1);
  }

  let bancos = session.bancos;
  if (!bancos || bancos.length === 0) {
    try {
      process.stdout.write(`${colors.dim}Fetching databases from cloud...${colors.reset}\r`);
      bancos = await listDatabases();
      saveSession({ bancos });
    } catch (err) {
      printError(`Failed to fetch databases: ${err.message}`);
      process.exit(1);
    }
  }

  const switchArg = args[0];
  if (switchArg) {
    const idx = Number.parseInt(switchArg, 10);
    let selected = null;
    if (!Number.isNaN(idx) && idx >= 1 && idx <= bancos.length) {
      selected = bancos[idx - 1];
    } else {
      selected = bancos.find(
        (b) =>
          b.Identificador === switchArg ||
          b.Descricao?.toLowerCase().includes(switchArg.toLowerCase())
      );
    }

    if (!selected) {
      printError(`Database not found matching "${switchArg}".`);
      process.exit(1);
    }

    saveSession({ bancoSelecionado: selected });
    success(`Active company database set to: ${colors.bold(selected.Descricao || selected.Nome)}`);
    console.log(`  GUID: ${colors.cyan(selected.Identificador)}\n`);
    return;
  }

  const currentGuid = session.bancoSelecionado?.Identificador;
  const rows = bancos.map((b, idx) => {
    const isCurrent = b.Identificador === currentGuid;
    return [
      isCurrent ? `${colors.green}${symbols.check} [${idx + 1}]${colors.reset}` : `  [${idx + 1}]`,
      b.Descricao || b.Nome || 'N/A',
      b.CnpjCpf || 'N/A',
      b.Identificador,
    ];
  });

  table(['#', 'Company Database Name', 'CNPJ/CPF', 'GUID'], rows);

  console.log(`\n${colors.dim}To switch active database: secullum-agent-cli databases <number>${colors.reset}\n`);
}

module.exports = { databasesCommand };
