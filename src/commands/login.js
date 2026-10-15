/**
 * commands/login.js - Standalone Cloud Authentication Command.
 * Connects directly to https://autenticador.secullum.com.br/token.
 * Zero external dependencies.
 */

'use strict';

const readline = require('node:readline');
const { authenticate, listDatabases } = require('../auth');
const { loadSession, saveSession, clearSession, getSessionFilePath } = require('../session');
const {
  colors,
  symbols,
  header,
  section,
  keyValue,
  success,
  error: printError,
  warn,
  info,
} = require('../utils');

/**
 * Prompt user in terminal with optional password masking.
 * @param {string} query
 * @param {boolean} [mask=false]
 * @returns {Promise<string>}
 */
function promptUser(query, mask = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (!mask) {
      rl.question(query, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
      return;
    }

    // Masked password input
    process.stdout.write(query);
    let pass = '';
    const stdin = process.stdin;
    const oldRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const onData = (chunk) => {
      const char = chunk.toString('utf-8');
      if (char === '\r' || char === '\n' || char === '\u0004') {
        process.stdout.write('\n');
        cleanup();
        resolve(pass.trim());
      } else if (char === '\u0003') { // Ctrl+C
        process.stdout.write('\n');
        cleanup();
        process.exit(1);
      } else if (char === '\u0008' || char === '\x7f') { // Backspace
        if (pass.length > 0) {
          pass = pass.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        pass += char;
        process.stdout.write('*');
      }
    };

    function cleanup() {
      stdin.removeListener('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(oldRaw);
      rl.close();
    }

    stdin.on('data', onData);
  });
}

/**
 * login command - Authenticate directly with Secullum Cloud.
 * @param {string[]} [args=[]]
 */
async function loginCommand(args = []) {
  header('Secullum Cloud - Direct Authentication');
  info('Authenticating directly with https://autenticador.secullum.com.br');

  let username = '';
  let password = '';
  let selectedBancoArg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user' || args[i] === '-u') {
      username = args[++i];
    } else if (args[i] === '--password' || args[i] === '--pass' || args[i] === '-p') {
      password = args[++i];
    } else if (args[i] === '--banco' || args[i] === '-b') {
      selectedBancoArg = args[++i];
    }
  }

  if (!username) {
    username = await promptUser('E-mail: ');
  }
  if (!username) {
    printError('E-mail is required.');
    process.exit(1);
  }

  if (!password) {
    password = await promptUser('Password: ', true);
  }
  if (!password) {
    printError('Password is required.');
    process.exit(1);
  }

  try {
    process.stdout.write(`${colors.dim}Authenticating with Secullum Authenticator...${colors.reset}\r`);
    const tokenData = await authenticate(username, password);
    success(`Successfully authenticated as ${colors.bold(username)}`);

    process.stdout.write(`${colors.dim}Fetching company databases...${colors.reset}\r`);
    const bancos = await listDatabases(tokenData.access_token, username);

    if (!bancos || bancos.length === 0) {
      warn('No active company databases found for this account.');
      saveSession({ bancos: [] });
      return;
    }

    saveSession({ bancos });

    let activeBanco = null;

    if (bancos.length === 1) {
      activeBanco = bancos[0];
      info(`Auto-selected only available database: ${colors.cyan(activeBanco.Descricao || activeBanco.Nome)}`);
    } else if (selectedBancoArg) {
      const idx = Number.parseInt(selectedBancoArg, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= bancos.length) {
        activeBanco = bancos[idx - 1];
      } else {
        activeBanco = bancos.find(
          (b) =>
            b.Identificador === selectedBancoArg ||
            b.Descricao?.toLowerCase() === selectedBancoArg.toLowerCase()
        );
      }
    }

    if (!activeBanco) {
      section('Select Company Database');
      bancos.forEach((b, idx) => {
        const desc = b.Descricao || b.Nome || 'Database';
        const doc = b.CnpjCpf ? ` (${b.CnpjCpf})` : '';
        console.log(`  ${colors.bold(`[${idx + 1}]`)} ${colors.cyan(desc)}${colors.dim(doc)}`);
      });

      const choice = await promptUser(`Select database (1-${bancos.length}): `);
      const chosenIdx = Number.parseInt(choice, 10);
      if (chosenIdx >= 1 && chosenIdx <= bancos.length) {
        activeBanco = bancos[chosenIdx - 1];
      } else {
        activeBanco = bancos[0];
      }
    }

    saveSession({ bancoSelecionado: activeBanco });

    success(`Active company database set to: ${colors.bold(activeBanco.Descricao || activeBanco.Nome)}`);
    keyValue('Database GUID', activeBanco.Identificador);
    if (activeBanco.CnpjCpf) keyValue('CNPJ / CPF', activeBanco.CnpjCpf);
    keyValue('Session File', getSessionFilePath());

    console.log(`\n${colors.green}Next steps:${colors.reset}`);
    console.log(`  ${colors.bold('secullum-agent-cli equipment')}    (List equipment in cloud database)`);
    console.log(`  ${colors.bold('secullum-agent-cli connect')}      (Launch standalone WebSocket agent)`);
  } catch (err) {
    printError(`Authentication failed: ${err.message}`);
    process.exit(1);
  }
}

/**
 * logout command - Clear local session credentials.
 */
function logoutCommand() {
  header('Secullum Cloud - Logout');
  clearSession();
  success('Cloud session cleared from disk.');
}

module.exports = {
  loginCommand,
  logoutCommand,
  promptUser,
};
