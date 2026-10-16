#!/usr/bin/env node

/**
 * bin/cli.js - Standalone CLI for Secullum RH Communication Agent.
 * Completely independent of the official desktop application and background service.
 * Supports manufacturer protocols (Henry, Control iD, Topdata), USB biometric
 * reader management, continuous live monitoring, and OS background daemonization.
 * Zero external npm dependencies (pure standard Node.js).
 */

'use strict';

// If running as background daemon, redirect console/stdout to daemon log file
if (process.env.SECULLUM_DAEMON === '1') {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const logFile = path.join(os.homedir(), '.secullum-agent.log');

  const logToFile = (chunk) => {
    try {
      const clean = String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
      fs.appendFileSync(logFile, clean, 'utf-8');
    } catch {}
  };

  process.stdout.write = (chunk, encoding, callback) => {
    logToFile(chunk);
    if (typeof callback === 'function') callback();
    return true;
  };

  process.stderr.write = (chunk, encoding, callback) => {
    logToFile(chunk);
    if (typeof callback === 'function') callback();
    return true;
  };

  process.on('uncaughtException', (err) => {
    logToFile(`\n[FATAL UNCAUGHT EXCEPTION] ${err ? (err.stack || err) : 'Unknown error'}\n`);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logToFile(`\n[FATAL UNHANDLED REJECTION] ${reason ? (reason.stack || reason) : 'Unknown reason'}\n`);
  });
}

const { colors } = require('../src/utils');

// Commands
const { statusCommand } = require('../src/commands/status');
const { loginCommand, logoutCommand } = require('../src/commands/login');
const { databasesCommand } = require('../src/commands/databases');
const {
  equipmentListCommand,
  equipmentAddCommand,
  equipmentRemoveCommand,
  equipmentTestCommand,
  equipmentSyncTimeCommand,
  equipmentCollectCommand,
  equipmentSendEmployeesCommand,
  equipmentDeleteEmployeesCommand,
  equipmentClearEmployeesCommand,
  equipmentSendEmployerCommand,
  equipmentReceiveEmployerCommand,
  equipmentReceiveBiometricsCommand,
} = require('../src/commands/equipment');
const { connectCommand } = require('../src/commands/connect');
const { monitorCommand } = require('../src/commands/monitor');
const { timeCommand } = require('../src/commands/time');
const {
  biometricStatusCommand,
  biometricScanCommand,
  biometricSelectCommand,
  biometricCaptureCommand,
} = require('../src/commands/biometric');
const {
  daemonStatusCommand,
  daemonStartCommand,
  daemonStopCommand,
  daemonRestartCommand,
  daemonLogsCommand,
  daemonInstallCommand,
  daemonUninstallCommand,
} = require('../src/commands/daemon');

function printHelp() {
  console.log(`
${colors.bold(colors.cyan('Secullum RH — Standalone Communication Agent CLI'))}
${colors.dim('Completely independent cross-platform agent for Windows and Linux')}

${colors.bold('USAGE:')}
  secullum-agent-cli [command] [options]

${colors.bold('CORE COMMANDS:')}
  ${colors.green('status')}                   Show agent dashboard, cloud auth, database & equipment (default)
  ${colors.green('login')}                    Authenticate directly with Secullum Cloud OAuth2
  ${colors.green('logout')}                   Clear saved cloud session credentials
  ${colors.green('databases [number|guid]')}  List company databases or switch active database (alias: bancos)
  ${colors.green('connect')}                  Launch the standalone RealTime WebSocket agent in foreground
  ${colors.green('monitor')}                  Continuous live monitoring dashboard (GUI replica)
  ${colors.green('time')}                     Check Secullum Cloud server clock and calculate drift

${colors.bold('EQUIPMENT & MANUFACTURER PROTOCOLS:')}
  ${colors.green('equipment')}                List all equipment with real-time LAN socket probe
  ${colors.green('equipment:add <id>')}       Enable equipment for this agent machine
  ${colors.green('equipment:remove <id>')}    Disable equipment for this agent machine
  ${colors.green('equipment:test <id>')}      Directly probe LAN TCP socket connection to equipment
  ${colors.green('equipment:sync-time <id>')} Direct clock sync via manufacturer protocol (Henry, Control iD, Topdata)
  ${colors.green('equipment:collect <id>')}   Collect punch records (AFD / Batidas) from REP and upload to cloud
  ${colors.green('equipment:send-employees <id>')} Transmit employee list from cloud to REP hardware
  ${colors.green('equipment:delete-employees <id> [doc...]')} Delete employees & biometrics from REP memory (ApagarPessoas)
  ${colors.green('equipment:clear-employees <id>')} Wipe all employee records from REP memory (ApagarListaPessoas)
  ${colors.green('equipment:send-employer <id>')}  Transmit employer data (DadosEmpregador) to REP hardware
  ${colors.green('equipment:get-employer <id>')}   Query employer data currently stored in REP hardware
  ${colors.green('equipment:receive-biometrics <id>')} Pull enrolled fingerprint templates from REP to cloud (ReceberDigitais)

${colors.bold('DESKTOP USB BIOMETRIC READERS:')}
  ${colors.green('biometric')}                Show active biometric reader and hardware connection
  ${colors.green('biometric:scan')}           Scan USB ports for connected readers (BioMini, iDBio, Nitgen, LC)
  ${colors.green('biometric:select <id>')}    Select active biometric reader (-1, 0, 9, 16, 2, 3)
  ${colors.green('biometric:capture [id]')}   Interactively capture fingerprint from desktop USB reader

${colors.bold('DAEMONIZATION & OS SERVICE:')}
  ${colors.green('daemon')}                   Show background daemon process status and recent logs
  ${colors.green('daemon:start')}             Start standalone agent in detached background mode
  ${colors.green('daemon:stop')}              Stop the background daemon process
  ${colors.green('daemon:restart')}           Restart the background daemon process
  ${colors.green('daemon:logs [-f]')}         View or tail background agent log file
  ${colors.green('daemon:install')}           Install persistent OS autostart service (Windows Service / Linux systemd)
  ${colors.green('daemon:uninstall')}         Remove persistent OS service

${colors.bold('OPTIONS:')}
  -i, --interval <sec>     Refresh interval in seconds for monitor mode (default: 3)
  -f, --follow             Follow log output in real time (for daemon:logs)
  -u, --user <email>       Secullum account e-mail for automated login
  -p, --pass <password>   Secullum account password for automated login
  -b, --banco <index|guid> Database selection for automated login
  -h, --help               Show this help message
  -v, --version            Show version

${colors.bold('EXAMPLES:')}
  # 1. Login directly to Secullum Cloud:
  secullum-agent-cli login

  # 2. View active dashboard:
  secullum-agent-cli status

  # 3. Continuous monitoring (GUI replica):
  secullum-agent-cli monitor

  # 4. Sync clock on equipment via native manufacturer protocol:
  secullum-agent-cli equipment:sync-time 2

  # 5. Scan USB ports for biometric readers:
  secullum-agent-cli biometric:scan

  # 6. Run agent permanently in background as a daemon:
  secullum-agent-cli daemon:start
  secullum-agent-cli daemon:logs -f
`);
}

async function main() {
  const args = process.argv.slice(2);

  let interval = 3;
  let follow = false;
  let command = null;
  const extraArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
    if (arg === '-v' || arg === '--version') {
      const pkg = require('../package.json');
      console.log(`secullum-agent-cli v${pkg.version}`);
      process.exit(0);
    }
    if ((arg === '-i' || arg === '--interval') && i + 1 < args.length) {
      interval = Number(args[++i]) || 3;
      continue;
    }
    if (arg === '-f' || arg === '--follow') {
      follow = true;
      continue;
    }
    if (arg.startsWith('-')) {
      extraArgs.push(arg);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        extraArgs.push(args[++i]);
      }
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      extraArgs.push(arg);
    }
  }

  // Default command: status
  if (!command) {
    command = 'status';
  }

  switch (command.toLowerCase()) {
    case 'status':
      await statusCommand();
      break;

    case 'login':
    case 'auth':
      await loginCommand(extraArgs);
      break;

    case 'logout':
      logoutCommand();
      break;

    case 'databases':
    case 'database':
    case 'bancos':
    case 'banco':
      await databasesCommand(extraArgs);
      break;

    case 'equipment':
    case 'equipments':
    case 'equipment:list':
      await equipmentListCommand();
      break;

    case 'equipment:add':
      await equipmentAddCommand(extraArgs[0]);
      break;

    case 'equipment:remove':
    case 'equipment:del':
      await equipmentRemoveCommand(extraArgs[0]);
      break;

    case 'equipment:test':
    case 'equipment:probe':
    case 'equipment:status':
      await equipmentTestCommand(extraArgs[0]);
      break;

    case 'equipment:sync-time':
    case 'equipment:synctime':
    case 'equipment:time':
      await equipmentSyncTimeCommand(extraArgs[0]);
      break;

    case 'equipment:collect':
    case 'equipment:coletar':
    case 'equipment:afd':
      await equipmentCollectCommand(extraArgs[0], extraArgs.slice(1));
      break;

    case 'equipment:send-employees':
    case 'equipment:send-users':
    case 'equipment:enviar-pessoas':
    case 'equipment:funcionarios':
      await equipmentSendEmployeesCommand(extraArgs[0], extraArgs.slice(1));
      break;

    case 'equipment:delete-employees':
    case 'equipment:delete-users':
    case 'equipment:apagar-pessoas':
    case 'equipment:excluir-pessoas':
    case 'equipment:remover-pessoas':
      await equipmentDeleteEmployeesCommand(extraArgs[0], extraArgs.slice(1));
      break;

    case 'equipment:clear-employees':
    case 'equipment:clear-users':
    case 'equipment:apagar-todos':
    case 'equipment:limpar-pessoas':
    case 'equipment:wipe-employees':
      await equipmentClearEmployeesCommand(extraArgs[0]);
      break;

    case 'equipment:send-employer':
    case 'equipment:send-empresa':
    case 'equipment:enviar-empregador':
    case 'equipment:empregador':
      await equipmentSendEmployerCommand(extraArgs[0]);
      break;

    case 'equipment:get-employer':
    case 'equipment:receive-employer':
    case 'equipment:obter-empregador':
      await equipmentReceiveEmployerCommand(extraArgs[0]);
      break;

    case 'equipment:receive-biometrics':
    case 'equipment:get-biometrics':
    case 'equipment:puxar-digitais':
    case 'equipment:receber-digitais':
    case 'equipment:biometrics':
      await equipmentReceiveBiometricsCommand(extraArgs[0]);
      break;

    case 'biometric':
    case 'biometric:status':
    case 'biometria':
      await biometricStatusCommand();
      break;

    case 'biometric:scan':
      await biometricScanCommand();
      break;

    case 'biometric:select':
      await biometricSelectCommand(extraArgs[0]);
      break;

    case 'biometric:capture':
    case 'biometric:capturar':
      await biometricCaptureCommand(extraArgs[0]);
      break;

    case 'daemon':
    case 'daemon:status':
    case 'service':
    case 'service:status':
      await daemonStatusCommand();
      break;

    case 'daemon:start':
    case 'service:start':
      await daemonStartCommand();
      break;

    case 'daemon:stop':
    case 'service:stop':
      await daemonStopCommand();
      break;

    case 'daemon:restart':
    case 'service:restart':
      await daemonRestartCommand();
      break;

    case 'daemon:logs':
    case 'service:logs':
      await daemonLogsCommand(follow);
      break;

    case 'daemon:install':
    case 'service:install':
      await daemonInstallCommand();
      break;

    case 'daemon:uninstall':
    case 'service:uninstall':
      await daemonUninstallCommand();
      break;

    case 'connect':
    case 'run':
    case 'start':
      await connectCommand(extraArgs);
      break;

    case 'monitor':
      await monitorCommand(interval);
      break;

    case 'time':
    case 'sync':
    case 'clock':
      await timeCommand(extraArgs);
      break;

    default:
      console.error(colors.red(`\n Unknown command: '${command}'`));
      console.error(colors.dim(` Run 'secullum-agent-cli --help' for available commands.\n`));
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(colors.red(`\n Error: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
