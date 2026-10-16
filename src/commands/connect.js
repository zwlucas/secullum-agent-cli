/**
 * commands/connect.js - Launch the Standalone Secullum RealTime WebSocket Agent.
 * Replaces the entire official background service with a pure standalone process.
 * Zero external dependencies.
 */

'use strict';

const os = require('node:os');
const { loadSession, getAddedEquipmentIds } = require('../session');
const { listEquipments, uploadPunchRecords, fetchEmployees, fetchEmployer, uploadBiometrics } = require('../pontoweb');
const { normalizeEquipment } = require('../equipment');
const {
  syncEquipmentDateTime,
  collectEquipmentRecords,
  sendEquipmentEmployees,
  deleteEquipmentEmployees,
  clearEquipmentEmployees,
  sendEquipmentEmployer,
  receiveEquipmentEmployer,
  receiveEquipmentBiometrics,
} = require('../protocols/dispatcher');
const { probeTcp } = require('../probe');
const { captureBiometric } = require('../biometric');
const { RealTimeGateway } = require('../realtime');
const {
  colors,
  symbols,
  header,
  keyValue,
  success,
  error: printError,
  warn,
  info,
} = require('../utils');

/**
 * connect command - Connect directly to Secullum RealTime cloud WebSocket gateway.
 * @param {string[]} [args=[]]
 */
async function connectCommand(args = []) {
  header('Secullum Cloud — Standalone RealTime Agent');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('No active session. Please run: secullum-agent-cli login');
    process.exit(1);
  }

  if (!session.bancoSelecionado) {
    printError('No company database selected. Please run: secullum-agent-cli databases');
    process.exit(1);
  }

  const hostname = os.hostname();
  info(`Starting standalone agent on ${colors.bold(hostname)}`);
  keyValue('Active Company', session.bancoSelecionado.Descricao || session.bancoSelecionado.Nome);
  keyValue('Database GUID', session.bancoSelecionado.Identificador);

  // Fetch registered equipment from cloud
  let allEquipments = [];
  try {
    process.stdout.write(`${colors.dim}Loading equipment list from cloud...${colors.reset}\r`);
    allEquipments = await listEquipments();
  } catch {}

  const addedIds = getAddedEquipmentIds();
  // If user explicitly added equipment, filter; otherwise announce all registered equipment
  const activeEquipments =
    addedIds.length > 0
      ? allEquipments.filter((eq) => addedIds.includes(Number(eq.Id ?? eq.id)))
      : allEquipments;

  keyValue('Active Equipment', `${activeEquipments.length} equipment announced to cloud`);

  const gateway = new RealTimeGateway({
    equipments: activeEquipments,
    bancoId: session.bancoSelecionado.Identificador,
    autoReconnect: true,
  });

  gateway.on('connecting', (data) => {
    info(`Connecting to WebSocket: ${colors.cyan(data.url)}`);
  });

  gateway.on('connected', () => {
    success('WebSocket transport connected. Sending OAuth handshake...');
  });

  gateway.on('authenticated', () => {
    success('Handshake accepted! Authenticated with Secullum RealTime Cloud.');
  });

  let pollInterval = null;

  gateway.on('registered', (agentData) => {
    success(`Agent registered on Hub "Comunicacao" (MAC: ${agentData.MAC}, Equipments: ${agentData.ListaEquipamentos.length})`);
    console.log(`\n${colors.cyan}${symbols.bullet} Standalone agent is now LIVE. Listening for cloud events...${colors.reset}`);
    console.log(`${colors.dim}Background auto-polling of time clocks active (every 60s). Press Ctrl+C to stop.${colors.reset}\n`);

    // Start background auto-collection polling for punches
    if (!pollInterval && activeEquipments.length > 0) {
      let isPolling = false;
      pollInterval = setInterval(async () => {
        if (isPolling) return;
        isPolling = true;
        try {
          for (const eqRaw of activeEquipments) {
            const eq = normalizeEquipment(eqRaw);
            if (!eq.ip || eq.comunicacao === 3) continue;

            const probe = await probeTcp(eq.ip, eq.porta, 1500);
            if (!probe.ok) continue;

            const res = await collectEquipmentRecords(eq, eq.ultimoNsr, 50);
            if (res.ok && res.records && res.records.length > 0) {
              const timeStr = new Date().toLocaleTimeString();
              console.log(`\n${colors.bold(colors.green(`[${timeStr}] [Auto-Coleta] ${res.records.length} nova(s) batida(s) de #${eq.id} (${eq.descricao})`))}`);
              try {
                await uploadPunchRecords(res.records, false);
                gateway.sendHubMethod('Comunicacao', 'InformarNsrEquipamento', [eq.id, res.lastNsr]);
                gateway.sendHubMethod('Comunicacao', 'ReceberRegistrosTabelaTemporaria', []);
                eq.ultimoNsr = res.lastNsr;
                console.log(`  ${colors.dim}Batidas salvas no Secullum Cloud. Novo NSR: ${res.lastNsr} ${symbols.check}${colors.reset}`);
              } catch (upErr) {
                console.log(`  ${colors.yellow}Falha ao subir para Secullum Cloud: ${upErr.message}${colors.reset}`);
              }
            }
          }
        } catch {} finally {
          isPolling = false;
        }
      }, 60000);
    }
  });

  gateway.on('ping', (data) => {
    const time = data.timestamp.toLocaleTimeString();
    console.log(`  ${colors.dim}[${time}] Cloud Heartbeat: PING received -> responded PONG ${symbols.check}${colors.reset}`);
  });

  gateway.on('cloud_event', async (evt) => {
    const time = evt.timestamp.toLocaleTimeString();
    console.log(`\n${colors.bold(colors.magenta(`[${time}] Cloud Event: ${evt.eventName}`))}`);
    if (evt.args && evt.args.length > 0) {
      console.log(colors.dim(JSON.stringify(evt.args, null, 2)));
    }

    // 1. Clock synchronization request
    if (evt.eventName === 'EnviarDataHora') {
      const equipId = evt.args[0];
      info(`Server requested clock sync for equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        try {
          const res = await syncEquipmentDateTime(targetEq);
          if (res.ok) {
            success(`Clock synced with ${res.manufacturer} equipment #${equipId} (${res.latencyMs}ms)`);
            gateway.sendCommunicationProgress(equipId, 'Data e hora sincronizadas', 100);
          } else {
            warn(`Clock sync failed for equipment #${equipId}: ${res.error}`);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Error syncing clock with equipment #${equipId}: ${err.message}`);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }

    // 2. Punch records collection request (ReceberRegistros)
    if (evt.eventName === 'ReceberRegistros') {
      const equipId = evt.args[0];
      info(`Cloud requested punch collection for equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        gateway.sendCommunicationProgress(equipId, 'Coletando registros do relógio...', 25);
        try {
          const res = await collectEquipmentRecords(targetEq, targetEq.ultimoNsr, 200);
          if (res.ok) {
            gateway.sendCommunicationProgress(equipId, 'Enviando registros para a nuvem...', 75);
            if (res.records.length > 0) {
              await uploadPunchRecords(res.records, false);
              gateway.sendHubMethod('Comunicacao', 'InformarNsrEquipamento', [equipId, res.lastNsr]);
              gateway.sendHubMethod('Comunicacao', 'ReceberRegistrosTabelaTemporaria', []);
              targetEq.ultimoNsr = res.lastNsr;
            }
            success(`Coleta concluída para #${equipId}: ${res.rawCount} registros (NSR: ${res.lastNsr})`);
            gateway.sendCommunicationProgress(equipId, `${res.rawCount} registros coletados com sucesso`, 100);
          } else {
            warn(`Falha na coleta de registros para #${equipId}: ${res.error}`);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Erro ao coletar registros de #${equipId}: ${err.message}`);
          gateway.sendCommunicationProgress(equipId, `Erro: ${err.message}`, 0);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }

    // 3. Employee list push request (EnviarListaPessoas / ListarPessoas)
    if (evt.eventName === 'EnviarListaPessoas' || evt.eventName === 'ListarPessoas') {
      const equipId = evt.args[0];
      info(`Cloud requested employee sync for equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        gateway.sendCommunicationProgress(equipId, 'Buscando funcionários cadastrados na nuvem...', 25);
        try {
          const emps = await fetchEmployees();
          gateway.sendCommunicationProgress(equipId, `Transmitindo ${emps.length} funcionários ao REP...`, 50);
          const res = await sendEquipmentEmployees(targetEq, emps);
          if (res.ok) {
            success(`Enviados ${res.count} funcionários com sucesso para equipamento #${equipId}`);
            gateway.sendHubMethod('Comunicacao', 'InformarPessoasEnviadas', [equipId, res.count]);
            gateway.sendCommunicationProgress(equipId, `${res.count} pessoas enviadas com sucesso`, 100);
          } else {
            warn(`Falha ao enviar funcionários para #${equipId}: ${res.error}`);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Erro ao enviar pessoas para #${equipId}: ${err.message}`);
          gateway.sendCommunicationProgress(equipId, `Erro: ${err.message}`, 0);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }

    // 4. Biometric desktop reader capture request (CapturarDigital)
    if (evt.eventName === 'CapturarDigital') {
      const tipoBiometria = evt.args[0] ?? 0;
      info(`Cloud requested active fingerprint capture on desktop USB reader (Tipo: ${tipoBiometria})`);
      try {
        const bioResult = await captureBiometric({ readerId: tipoBiometria });
        if (bioResult.ok) {
          success(`Digital capturada com sucesso! Qualidade: ${bioResult.Qualidade}%`);
          gateway.sendHubMethod('Comunicacao', 'InformarBiometriaCapturada', [bioResult]);
        } else {
          warn(`Falha na captura biométrica: ${bioResult.error}`);
          gateway.sendHubMethod('Comunicacao', 'InformarNotificacaoLeitorBiometrico', [tipoBiometria, bioResult.error || 'Falha ao capturar']);
        }
      } catch (err) {
        warn(`Erro na captura biométrica: ${err.message}`);
        gateway.sendHubMethod('Comunicacao', 'InformarNotificacaoLeitorBiometrico', [tipoBiometria, err.message]);
      }
    }

    // 5. Employer send request (EnviarEmpregador)
    // Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.EnviarEmpregador
    if (evt.eventName === 'EnviarEmpregador') {
      const equipId = evt.args[0];
      const payloadEmployer = evt.args[1];
      info(`Cloud requested employer data send for equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        gateway.sendCommunicationProgress(equipId, 'Obtendo dados do empregador...', 25);
        try {
          const employer = payloadEmployer || (await fetchEmployer(equipId));
          gateway.sendCommunicationProgress(equipId, 'Transmitindo dados do empregador ao REP...', 60);
          const res = await sendEquipmentEmployer(targetEq, employer);
          if (res.ok) {
            success(`Dados do empregador enviados com sucesso para #${equipId} via protocolo ${res.manufacturer}!`);
            gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, '']);
            gateway.sendCommunicationProgress(equipId, 'Dados do empregador enviados com sucesso', 100);
          } else {
            warn(`Falha ao enviar empregador para #${equipId}: ${res.error}`);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Erro ao enviar empregador para #${equipId}: ${err.message}`);
          gateway.sendCommunicationProgress(equipId, `Erro: ${err.message}`, 0);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }

    // 6. Employer receive request (ReceberEmpregador)
    // Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.ReceberEmpregador
    if (evt.eventName === 'ReceberEmpregador') {
      const equipId = evt.args[0];
      info(`Cloud requested employer read from equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        gateway.sendCommunicationProgress(equipId, 'Lendo dados do empregador do relógio...', 50);
        try {
          const res = await receiveEquipmentEmployer(targetEq);
          if (res.ok && res.employer) {
            success(`Dados do empregador recebidos com sucesso de #${equipId}: ${res.employer.RazaoSocial}`);
            gateway.sendHubMethod('Comunicacao', 'InformarEmpregadorEquipamento', [equipId, res.employer]);
            gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, '']);
            gateway.sendCommunicationProgress(equipId, 'Empregador lido com sucesso', 100);
          } else {
            warn(`Falha ao receber empregador de #${equipId}: ${res.error}`);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Erro ao receber empregador de #${equipId}: ${err.message}`);
          gateway.sendCommunicationProgress(equipId, `Erro: ${err.message}`, 0);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }

    // 7. Receive biometrics request (ReceberDigitais)
    // Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.ReceberDigitais
    if (evt.eventName === 'ReceberDigitais') {
      const equipId = evt.args[0];
      const listaPessoas = evt.args[1] || [];
      info(`Cloud requested biometric pull (ReceberDigitais) for equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        gateway.sendCommunicationProgress(equipId, 'Consultando funcionários...', 20);
        try {
          let employees = listaPessoas;
          if (!employees || employees.length === 0) {
            employees = await fetchEmployees();
          }

          gateway.sendCommunicationProgress(equipId, 'Lendo digitais do equipamento...', 40);
          const res = await receiveEquipmentBiometrics(targetEq, employees, (curr, tot, name) => {
            const pct = 40 + Math.round((curr / tot) * 40);
            gateway.sendCommunicationProgress(equipId, `Lendo digital ${curr}/${tot}: ${name}`, pct);
          });

          if (res.ok) {
            success(`Digitais recebidas com sucesso de #${equipId}: ${res.count} template(s) via protocolo ${res.manufacturer}`);
            gateway.sendCommunicationProgress(equipId, 'Transmitindo digitais à nuvem...', 90);
            await uploadBiometrics(equipId, res.biometrics, res.tipoBiometria, gateway);
            gateway.sendCommunicationProgress(equipId, 'Digitais recebidas e atualizadas com sucesso', 100);
          } else {
            warn(`Falha ao receber digitais de #${equipId}: ${res.error}`);
            gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, res.error || 'Falha no recebimento']);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Erro ao receber digitais de #${equipId}: ${err.message}`);
          gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, err.message]);
          gateway.sendCommunicationProgress(equipId, `Erro: ${err.message}`, 0);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }

    // 8. Delete employees request (ApagarPessoas / ApagarListaPessoas)
    // Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.ApagarPessoas and ApagarListaPessoas
    if (evt.eventName === 'ApagarPessoas' || evt.eventName === 'ApagarListaPessoas') {
      const equipId = evt.args[0];
      const lista = evt.args[1] || [];
      info(`Cloud requested employee deletion (${evt.eventName}) for equipment #${equipId}`);
      const targetRaw = allEquipments.find((e) => Number(e.Id ?? e.id) === Number(equipId));
      if (targetRaw) {
        const targetEq = normalizeEquipment(targetRaw);
        gateway.sendCommunicationProgress(equipId, 'Iniciando exclusão de funcionários no REP...', 20);
        try {
          let employees = lista;
          if (!employees || employees.length === 0) {
            employees = await fetchEmployees();
          }

          gateway.sendCommunicationProgress(equipId, `Apagando ${employees.length} funcionário(s) da memória do relógio...`, 40);
          const res = await deleteEquipmentEmployees(targetEq, employees, (curr, tot, name) => {
            const pct = 40 + Math.round((curr / tot) * 50);
            gateway.sendCommunicationProgress(equipId, `Excluindo ${curr}/${tot}: ${name}`, pct);
          });

          if (res.ok) {
            success(`Exclusão concluída com sucesso em #${equipId}: ${res.count} pessoa(s) removida(s)`);
            gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, '']);
            gateway.sendCommunicationProgress(equipId, `${res.count} pessoa(s) apagada(s) com sucesso`, 100);
          } else {
            warn(`Falha ao apagar pessoas de #${equipId}: ${res.error}`);
            gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, res.error || 'Falha na exclusão']);
            gateway.sendCommunicationProgress(equipId, `Falha: ${res.error}`, 0);
          }
        } catch (err) {
          warn(`Erro ao apagar pessoas de #${equipId}: ${err.message}`);
          gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [equipId, err.message]);
          gateway.sendCommunicationProgress(equipId, `Erro: ${err.message}`, 0);
        }
      } else {
        gateway.sendCommunicationProgress(equipId, 'Equipamento desconhecido', 0);
      }
    }
  });

  gateway.on('error', (err) => {
    printError(`Gateway error: ${err.message}`);
  });

  gateway.on('disconnected', (data) => {
    warn(`Disconnected from cloud gateway (code: ${data.code}, reason: ${data.reason || 'None'})`);
  });

  gateway.on('reconnecting', (data) => {
    info(`Reconnecting in ${data.delay / 1000}s...`);
  });

  // Keep connection process alive indefinitely by holding an active event loop timer
  const keepAliveTimer = setInterval(() => {}, 1000 * 60 * 60);

  // Graceful exit on Ctrl+C or kill signal
  const cleanExit = () => {
    console.log(`\n${colors.dim}Stopping standalone agent...${colors.reset}`);
    clearInterval(keepAliveTimer);
    if (pollInterval) clearInterval(pollInterval);
    gateway.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);

  try {
    await gateway.connect();
    // Keep connection process alive indefinitely
    await new Promise(() => {});
  } catch (err) {
    clearInterval(keepAliveTimer);
    if (pollInterval) clearInterval(pollInterval);
    printError(`Connection failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { connectCommand };

