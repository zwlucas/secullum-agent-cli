/**
 * commands/monitor.js - Continuous Standalone Agent Monitor.
 * Faithfully reproduces the official Electron interface layout:
 *   - "Dados da Conta" (Usuário, Banco de Dados)
 *   - "Equipamentos" Table (Nome, Tipo, Endereço IP, Status do Equipamento)
 *   - "Serviço de Comunicação" (Status, Servidor, Computador, Versão)
 * Zero external dependencies.
 */

'use strict';

const os = require('node:os');
const { loadSession, getAddedEquipmentIds } = require('../session');
const { getServerTime, listEquipments, AGENT_VERSION } = require('../pontoweb');
const { probeTcp } = require('../probe');
const { normalizeEquipment } = require('../equipment');
const { getBiometricStatus } = require('../biometric');
const {
  colors,
  symbols,
  clearScreen,
  table,
} = require('../utils');

/**
 * Continuous live monitor replicating official Secullum Electron GUI.
 * @param {number} [intervalSec=3]
 */
async function monitorCommand(intervalSec = 3) {
  let isRunning = true;
  let cycle = 0;

  const cleanExit = () => {
    isRunning = false;
    process.stdout.write('\n');
    process.exit(0);
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);

  while (isRunning) {
    cycle++;
    const session = loadSession();
    const now = new Date();

    clearScreen();
    console.log(`${colors.bold(colors.cyan('  Secullum RH — Agente de Comunicação'))} ${colors.dim(`(Standalone CLI · cycle #${cycle} · ${now.toLocaleTimeString()})`)}`);
    console.log(colors.dim(`  ${'━'.repeat(80)}`));

    if (!session || !session.accessToken) {
      console.log(`\n  ${colors.yellow(`${symbols.bullet} Nenhuma sessão ativa da nuvem.`)}`);
      console.log(`  Execute: ${colors.bold('secullum-agent-cli login')} para autenticar.\n`);
      await sleep(intervalSec * 1000);
      continue;
    }

    // 1. Dados da Conta (matches official Electron panel)
    const banco = session.bancoSelecionado;
    const bancoDesc = banco ? (banco.Descricao || banco.Nome) : 'Nenhum selecionado';
    const userDisplay = session.nome && session.usuario
      ? `${session.nome} - ${session.usuario}`
      : (session.usuario || 'N/A');

    console.log(`  ${colors.bold('Dados da Conta')}`);
    console.log(`    ${colors.dim('Usuário:')}        ${userDisplay}`);
    console.log(`    ${colors.dim('Banco de Dados:')} ${colors.cyan(bancoDesc)}`);
    console.log(colors.dim(`  ${'─'.repeat(80)}`));

    // Cloud REST latency check
    let srvTime = '...';
    let cloudOk = false;
    const startSrv = Date.now();
    try {
      const res = await getServerTime();
      srvTime = `${Date.now() - startSrv}ms`;
      cloudOk = true;
    } catch {
      srvTime = `${colors.red}Falha${colors.reset}`;
    }

    // 2. Equipamentos Table (matches official Electron table: Nome, Tipo, Endereço IP, Status do Equipamento)
    console.log(`  ${colors.bold('Equipamentos')}`);

    const addedIds = getAddedEquipmentIds();
    let rawEquipments = [];
    try {
      rawEquipments = await listEquipments();
    } catch {}

    const normalizedEquipments = rawEquipments.map((eq) => normalizeEquipment(eq, addedIds));

    // Show only added equipment if some are added, otherwise show all
    const displayList = normalizedEquipments.filter((eq) => addedIds.length === 0 || eq.adicionado);

    if (displayList.length > 0) {
      // Parallel TCP socket probes
      const probePromises = displayList.map(async (eq) => {
        if (eq.comunicacao === 3 || !eq.ip) {
          return { ...eq, probeResult: null };
        }
        const probe = await probeTcp(eq.ip, eq.porta, 1500);
        return { ...eq, probeResult: probe };
      });

      const probedList = await Promise.all(probePromises);

      const rows = probedList.map((eq) => {
        let statusDisplay = '';

        if (eq.comunicacao === 3) {
          statusDisplay = `${colors.dim}USB${colors.reset}`;
        } else if (eq.probeResult) {
          if (eq.probeResult.ok) {
            statusDisplay = `${colors.green}${symbols.check} Conectado${colors.reset} ${colors.dim}(${eq.probeResult.latencyMs}ms)${colors.reset}`;
          } else {
            statusDisplay = `${colors.red}${symbols.cross} Desconectado${colors.reset}`;
          }
        } else {
          statusDisplay = `${colors.red}${symbols.cross} Desconectado${colors.reset}`;
        }

        return [
          eq.descricao,
          eq.tipo,
          eq.ip || `${colors.dim}-${colors.reset}`,
          statusDisplay,
        ];
      });

      // Columns match bundle.js pn: Nome, Tipo, Endereço IP, Status do Equipamento
      table(['Nome', 'Tipo', 'Endereço IP', 'Status do Equipamento'], rows);
    } else {
      console.log(`    ${colors.dim}Nenhum equipamento adicionado para este agente.${colors.reset}`);
      console.log(`    ${colors.dim}Para adicionar, execute: ${colors.bold('secullum-agent-cli equipment:add <id>')}${colors.reset}\n`);
    }

    // 3. Serviço de Comunicação (matches official Electron footer)
    const bioStatus = getBiometricStatus();
    let bioDisplay = `${colors.dim}Desativado${colors.reset}`;
    if (bioStatus.id !== -1) {
      bioDisplay = bioStatus.conectado
        ? `${colors.green}${symbols.check} Conectado${colors.reset} ${colors.dim}(${bioStatus.nome} via USB)${colors.reset}`
        : `${colors.red}${symbols.cross} Desconectado${colors.reset} ${colors.dim}(${bioStatus.nome})${colors.reset}`;
    }

    console.log(colors.dim(`  ${'─'.repeat(80)}`));
    console.log(`  ${colors.bold('Serviço de Comunicação')}`);
    console.log(`    ${colors.dim('Status:')}            ${colors.green}${symbols.check} Em execução (Standalone CLI)${colors.reset}`);
    console.log(`    ${colors.dim('Servidor:')}          ${cloudOk ? `${colors.green}${symbols.check} Conectado${colors.reset} ${colors.dim}(pontowebcomunicacao.secullum.com.br · ${srvTime})${colors.reset}` : `${colors.red}${symbols.cross} Desconectado${colors.reset}`}`);
    console.log(`    ${colors.dim('Leitor Biométrico:')} ${bioDisplay}`);
    console.log(`    ${colors.dim('Computador:')}        ${os.hostname()}`);
    console.log(`    ${colors.dim('Versão:')}            ${AGENT_VERSION}`);
    console.log(colors.dim(`  ${'━'.repeat(80)}`));

    console.log(`  ${colors.dim}Atualizando a cada ${intervalSec}s. Pressione Ctrl+C para sair.${colors.reset}`);

    await sleep(intervalSec * 1000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { monitorCommand };
