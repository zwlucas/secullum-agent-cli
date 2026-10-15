/**
 * commands/daemon.js - CLI commands for background daemon and service management.
 * Zero external dependencies.
 */

'use strict';

const fs = require('node:fs');
const {
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  getRecentLogs,
  installOsService,
  uninstallOsService,
} = require('../daemon');
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
 * Display daemon running status and recent logs.
 */
async function daemonStatusCommand() {
  header('Secullum Agent — Status do Daemon / Serviço');

  const status = getDaemonStatus();

  section('Processo em Segundo Plano');
  if (status.isRunning) {
    keyValue('Estado', `${colors.green}${symbols.check} Em execução (Online)${colors.reset}`);
    keyValue('PID', String(status.pid));
    if (status.startedAt) {
      const started = new Date(status.startedAt);
      const uptimeMin = Math.round((Date.now() - started.getTime()) / 60000);
      keyValue('Iniciado em', `${started.toLocaleString()} (${uptimeMin} min ativos)`);
    }
  } else {
    keyValue('Estado', `${colors.red}${symbols.cross} Parado / Inativo${colors.reset}`);
  }

  keyValue('Arquivo PID', status.pidPath);
  keyValue('Arquivo de Log', status.logPath);

  // Recent logs
  section('Últimos Registros de Log');
  const logs = getRecentLogs(12);
  console.log(colors.dim(logs.trim() || 'Nenhum log registrado ainda.'));
  console.log();

  if (status.isRunning) {
    console.log(`${colors.dim}Comandos:${colors.reset}`);
    console.log(`  ${colors.bold('secullum-agent-cli daemon:stop')}    (Parar agente em segundo plano)`);
    console.log(`  ${colors.bold('secullum-agent-cli daemon:logs')}    (Ver logs completos)\n`);
  } else {
    console.log(`${colors.dim}Comandos:${colors.reset}`);
    console.log(`  ${colors.bold('secullum-agent-cli daemon:start')}   (Iniciar agente em segundo plano)`);
    console.log(`  ${colors.bold('secullum-agent-cli daemon:install')} (Instalar inicialização automática no sistema)\n`);
  }
}

/**
 * Start the agent as a background daemon.
 */
async function daemonStartCommand() {
  header('Secullum Agent — Iniciar Daemon em Segundo Plano');

  try {
    const res = startDaemon();
    success(`Agente Secullum iniciado com sucesso em segundo plano!`);
    keyValue('PID', String(res.pid));
    keyValue('Logs', res.logPath);
    console.log(`\n${colors.dim}Para verificar o status: ${colors.bold('secullum-agent-cli daemon:status')}${colors.reset}`);
    console.log(`${colors.dim}Para acompanhar logs:   ${colors.bold('secullum-agent-cli daemon:logs')}${colors.reset}\n`);
  } catch (err) {
    printError(`Falha ao iniciar daemon: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Stop the background daemon.
 */
async function daemonStopCommand() {
  header('Secullum Agent — Parar Daemon em Segundo Plano');

  try {
    const res = stopDaemon();
    success(`Agente Secullum (PID: ${res.pid}) foi encerrado.`);
    console.log();
  } catch (err) {
    printError(`Falha ao parar daemon: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Restart the background daemon.
 */
async function daemonRestartCommand() {
  header('Secullum Agent — Reiniciar Daemon');

  const status = getDaemonStatus();
  if (status.isRunning) {
    try {
      stopDaemon();
      info(`Processo anterior (PID: ${status.pid}) finalizado.`);
    } catch {}
  }

  try {
    const res = startDaemon();
    success(`Agente reiniciado com sucesso! Novo PID: ${res.pid}`);
    console.log();
  } catch (err) {
    printError(`Falha ao reiniciar daemon: ${err.message}`);
    process.exit(1);
  }
}

/**
 * View or tail daemon logs.
 * @param {boolean} [follow=false]
 */
async function daemonLogsCommand(follow = false) {
  header('Secullum Agent — Registros de Log');

  const status = getDaemonStatus();
  if (!fs.existsSync(status.logPath)) {
    warn(`Nenhum arquivo de log encontrado em: ${status.logPath}`);
    return;
  }

  if (!follow) {
    const logs = getRecentLogs(50);
    console.log(colors.dim(logs));
    console.log(`\n${colors.dim}Caminho do log: ${status.logPath}${colors.reset}\n`);
    return;
  }

  // Follow mode
  console.log(`${colors.dim}Acompanhando logs em tempo real (Ctrl+C para sair):${colors.reset}\n`);
  const initial = getRecentLogs(20);
  process.stdout.write(colors.dim(initial) + '\n');

  let lastSize = fs.statSync(status.logPath).size;
  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(status.logPath);
      if (stat.size > lastSize) {
        const stream = fs.createReadStream(status.logPath, {
          start: lastSize,
          end: stat.size,
          encoding: 'utf-8',
        });
        stream.on('data', (chunk) => process.stdout.write(chunk));
        lastSize = stat.size;
      }
    } catch {}
  }, 1000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    process.exit(0);
  });
}

/**
 * Install persistent OS autostart service (Windows Service Task / Linux systemd).
 */
async function daemonInstallCommand() {
  header('Secullum Agent — Instalação do Serviço do Sistema Operacional');

  try {
    const res = installOsService();
    success(`Serviço registrado com sucesso no ${res.platform.toUpperCase()}!`);
    keyValue('Detalhes', res.details);
    console.log(`\n${colors.dim}O agente agora iniciará automaticamente com o sistema operacional.${colors.reset}\n`);
  } catch (err) {
    printError(`Falha na instalação do serviço: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Uninstall persistent OS autostart service.
 */
async function daemonUninstallCommand() {
  header('Secullum Agent — Remoção do Serviço do Sistema Operacional');

  try {
    const res = uninstallOsService();
    success(`Serviço removido com sucesso.`);
    keyValue('Detalhes', res.details);
    console.log();
  } catch (err) {
    printError(`Falha na remoção do serviço: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  daemonStatusCommand,
  daemonStartCommand,
  daemonStopCommand,
  daemonRestartCommand,
  daemonLogsCommand,
  daemonInstallCommand,
  daemonUninstallCommand,
};
