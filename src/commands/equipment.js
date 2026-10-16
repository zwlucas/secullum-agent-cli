/**
 * commands/equipment.js - Standalone Equipment Management Command.
 * Queries Secullum Cloud REST API and directly probes LAN equipment.
 * Zero external dependencies.
 */

'use strict';

const {
  listEquipments,
  getEquipment,
  uploadPunchRecords,
  fetchEmployees,
  fetchEmployer,
  uploadBiometrics,
} = require('../pontoweb');
const { normalizeEquipment } = require('../equipment');
const { loadSession, getAddedEquipmentIds, addEquipmentId, removeEquipmentId } = require('../session');
const { probeTcp } = require('../probe');
const {
  syncEquipmentDateTime,
  collectEquipmentRecords,
  sendEquipmentEmployees,
  sendEquipmentEmployer,
  receiveEquipmentEmployer,
  receiveEquipmentBiometrics,
} = require('../protocols/dispatcher');
const {
  colors,
  symbols,
  header,
  section,
  keyValue,
  table,
  success,
  error: printError,
  warn,
  info,
} = require('../utils');

/**
 * List all equipment registered in the active company database.
 */
async function equipmentListCommand() {
  header('Secullum Cloud — Catálogo de Equipamentos');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('Nenhuma sessão ativa. Execute: secullum-agent-cli login');
    process.exit(1);
  }

  if (!session.bancoSelecionado) {
    printError('Nenhum banco de dados selecionado. Execute: secullum-agent-cli databases');
    process.exit(1);
  }

  try {
    process.stdout.write(`${colors.dim}Consultando API Secullum Cloud...${colors.reset}\r`);
    const rawList = await listEquipments();

    if (!Array.isArray(rawList) || rawList.length === 0) {
      info('Nenhum equipamento cadastrado neste banco de dados.');
      return;
    }

    const addedIds = getAddedEquipmentIds();
    const normalizedList = rawList.map((eq) => normalizeEquipment(eq, addedIds));

    // Probe LAN status for all IP equipment in parallel
    const probedList = await Promise.all(
      normalizedList.map(async (eq) => {
        if (eq.comunicacao === 3 || !eq.ip) {
          return { ...eq, probe: null };
        }
        const probe = await probeTcp(eq.ip, eq.porta, 1200);
        return { ...eq, probe };
      })
    );

    const rows = probedList.map((eq) => {
      let lanStatus = `${colors.dim}-${colors.reset}`;
      if (eq.comunicacao === 3) {
        lanStatus = `${colors.dim}USB${colors.reset}`;
      } else if (eq.probe) {
        lanStatus = eq.probe.ok
          ? `${colors.green}${symbols.check} Conectado (${eq.probe.latencyMs}ms)${colors.reset}`
          : `${colors.red}${symbols.cross} Desconectado${colors.reset}`;
      }

      const agentStatus = eq.adicionado
        ? `${colors.green}${symbols.check} Ativo${colors.reset}`
        : `${colors.dim}Inativo${colors.reset}`;

      const networkAddr = eq.ip ? `${eq.ip}:${eq.porta}` : `${colors.dim}USB/Serial${colors.reset}`;

      return [
        String(eq.id),
        eq.descricao,
        eq.tipo,
        networkAddr,
        lanStatus,
        agentStatus,
      ];
    });

    table(['ID', 'Nome', 'Tipo / Modelo', 'Endereço IP', 'Status do Equipamento', 'Agente'], rows);

    console.log(`\n${colors.dim}Comandos disponíveis:${colors.reset}`);
    console.log(`  ${colors.bold('secullum-agent-cli equipment:add <id>')}     (Ativar equipamento neste agente)`);
    console.log(`  ${colors.bold('secullum-agent-cli equipment:remove <id>')}  (Desativar equipamento deste agente)`);
    console.log(`  ${colors.bold('secullum-agent-cli equipment:test <id>')}    (Testar conectividade TCP na rede local)\n`);
  } catch (err) {
    printError(`Falha ao obter equipamentos: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Add equipment to active polling on this agent machine.
 * @param {string|number} id
 */
async function equipmentAddCommand(id) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:add 2');
    process.exit(1);
  }

  header(`Secullum Agent — Ativar Equipamento #${id}`);

  let details = null;
  try {
    const raw = await getEquipment(id);
    details = normalizeEquipment(raw);
  } catch {}

  addEquipmentId(id);
  success(`Equipamento #${id} ativado para este agente.`);

  if (details) {
    keyValue('Nome', details.descricao);
    keyValue('Tipo', details.tipo);
    if (details.ip) keyValue('Endereço IP', `${details.ip}:${details.porta}`);
  }

  console.log(`\n${colors.dim}Ao executar 'secullum-agent-cli connect', este equipamento será atendido.${colors.reset}\n`);
}

/**
 * Remove equipment from active polling on this agent machine.
 * @param {string|number} id
 */
async function equipmentRemoveCommand(id) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:remove 2');
    process.exit(1);
  }

  header(`Secullum Agent — Desativar Equipamento #${id}`);
  removeEquipmentId(id);
  success(`Equipamento #${id} desativado deste agente.`);
  console.log();
}

/**
 * Directly probe equipment network connectivity on the LAN via TCP socket.
 * @param {string|number} id
 */
async function equipmentTestCommand(id) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:test 2');
    process.exit(1);
  }

  header(`Secullum Agent — Testar Conexão Equipamento #${id}`);

  process.stdout.write(`${colors.dim}Buscando dados do equipamento na nuvem...${colors.reset}\r`);
  let eq;
  try {
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Informações do Equipamento');
  keyValue('Nome', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', eq.ip || 'Sem IP configurado (USB/Serial)');
  keyValue('Porta TCP', String(eq.porta));

  if (!eq.ip) {
    warn('Este equipamento não possui endereço IP configurado no Secullum.');
    return;
  }

  process.stdout.write(`\n${colors.dim}Enviando socket TCP para ${eq.ip}:${eq.porta}...${colors.reset}\r`);
  const result = await probeTcp(eq.ip, eq.porta, 3000);

  section('Resultado do Teste de Conexão na Rede Local');
  if (result.ok) {
    success(`Socket TCP conectado com sucesso! (${result.latencyMs}ms)`);
    keyValue('Status do Equipamento', `${colors.green}${symbols.check} Conectado${colors.reset}`);
    keyValue('Latência', `${result.latencyMs} ms`);
  } else {
    printError(`Falha na conexão: ${result.error}`);
    keyValue('Status do Equipamento', `${colors.red}${symbols.cross} Desconectado${colors.reset}`);
    console.log(`\n${colors.dim}Diagnóstico:${colors.reset}`);
    console.log(`  - Verifique se o relógio de ponto está ligado na tomada e na rede.`);
    console.log(`  - Verifique se o cabo de rede está conectado ao switch ou roteador.`);
    console.log(`  - Verifique se este computador está na mesma rede ou tem rota para ${eq.ip}.`);
    console.log(`  - Verifique as permissões de firewall para a porta TCP ${eq.porta}.`);
  }
  console.log();
}

/**
 * Synchronize date and time with equipment using its manufacturer protocol.
 * @param {string|number} id
 */
async function equipmentSyncTimeCommand(id) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:sync-time 3');
    process.exit(1);
  }

  header(`Secullum Agent — Sincronizar Relógio no Equipamento #${id}`);

  let eq;
  try {
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Equipamento Alvo');
  keyValue('Nome', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', `${eq.ip}:${eq.porta}`);

  const now = new Date();
  keyValue('Data/Hora a Enviar', now.toLocaleString());

  process.stdout.write(`\n${colors.dim}Enviando comando de sincronização de relógio via protocolo nativo...${colors.reset}\r`);
  const res = await syncEquipmentDateTime(eq, now);

  section('Resultado da Sincronização');
  if (res.ok) {
    success(`Data e hora sincronizadas com sucesso via protocolo ${res.manufacturer}! (${res.latencyMs}ms)`);
  } else {
    printError(`Falha na sincronização via protocolo ${res.manufacturer}: ${res.error}`);
    console.log(`\n${colors.dim}Nota: Se o equipamento for homologado pela Portaria 671 ou exigir chave criptográfica, o protocolo enviou a tentativa de quadro nativa.${colors.reset}`);
  }
  console.log();
}

/**
 * Collect punch records (AFD / Batidas de Ponto) from equipment and upload to Secullum Cloud.
 * @param {string|number} id - Equipment ID
 * @param {string[]} [extraArgs=[]]
 */
async function equipmentCollectCommand(id, extraArgs = []) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:collect 3');
    process.exit(1);
  }

  let count = 100;
  let customNsr = null;

  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if ((a === '-n' || a === '--count') && i + 1 < extraArgs.length) {
      count = parseInt(extraArgs[++i], 10) || 100;
    } else if ((a === '--nsr' || a === '-s') && i + 1 < extraArgs.length) {
      customNsr = parseInt(extraArgs[++i], 10);
    }
  }

  header(`Secullum Agent — Coleta de Marcações (AFD) #${id}`);

  let eq;
  try {
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Informações da Coleta');
  keyValue('Equipamento', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', `${eq.ip}:${eq.porta}`);
  const startNsr = customNsr !== null ? customNsr : eq.ultimoNsr;
  keyValue('NSR Inicial', String(startNsr));
  keyValue('Limite por Lote', String(count));

  process.stdout.write(`\n${colors.dim}Conectando ao REP e solicitando registros via protocolo nativo...${colors.reset}\r`);
  const res = await collectEquipmentRecords(eq, startNsr, count);

  if (!res.ok) {
    console.log();
    printError(`Falha na coleta de registros via protocolo ${res.manufacturer}: ${res.error}`);
    process.exit(1);
  }

  section(`Registros Coletados do Equipamento (${res.rawCount} marcações)`);
  if (res.records.length === 0) {
    info(`Nenhuma nova marcação pendente no equipamento (Último NSR no relógio: ${res.lastNsr}).`);
    console.log();
    return;
  }

  // Display records table
  const rows = res.records.slice(0, 15).map((r) => [
    String(r.Nsr),
    r.DataHora,
    r.CPF ? `CPF: ${r.CPF}` : (r.PIS ? `PIS: ${r.PIS}` : '-'),
    r.RegistroPortaria671 ? 'Portaria 671' : 'Portaria 1510',
    r.CRC || '-',
  ]);

  table(['NSR', 'Data / Hora', 'Documento', 'Padrão', 'CRC'], rows);

  if (res.records.length > 15) {
    console.log(`  ${colors.dim}... e mais ${res.records.length - 15} marcações exibidas parcialmente.${colors.reset}`);
  }

  // Upload to Secullum Cloud
  process.stdout.write(`\n${colors.dim}Enviando ${res.records.length} marcações para o Secullum PontoWeb Cloud...${colors.reset}\r`);
  try {
    await uploadPunchRecords(res.records, false);
    success(`${res.records.length} marcações enviadas com sucesso para o Secullum Cloud!`);
    keyValue('Novo Último NSR', String(res.lastNsr));
  } catch (err) {
    warn(`Marcações coletadas do REP, mas ocorreu falha ao salvar na nuvem: ${err.message}`);
  }
  console.log();
}

/**
 * Send employee list to equipment using its manufacturer-specific protocol.
 * @param {string|number} id - Equipment ID
 * @param {string[]} [extraArgs=[]]
 */
async function equipmentSendEmployeesCommand(id, extraArgs = []) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:send-employees 3');
    process.exit(1);
  }

  header(`Secullum Agent — Enviar Funcionários ao REP #${id}`);

  let eq;
  try {
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Equipamento Alvo');
  keyValue('Nome', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', `${eq.ip}:${eq.porta}`);

  process.stdout.write(`\n${colors.dim}Consultando funcionários ativos no Secullum Cloud...${colors.reset}\r`);
  let employees = [];
  try {
    employees = await fetchEmployees();
  } catch (err) {
    printError(`Falha ao obter funcionários da nuvem: ${err.message}`);
    process.exit(1);
  }

  if (!employees || employees.length === 0) {
    warn('Nenhum funcionário encontrado no banco de dados ativo.');
    return;
  }

  keyValue('Total de Funcionários', `${employees.length} colaboradores`);

  process.stdout.write(`\n${colors.dim}Transmitindo funcionários para o REP via protocolo nativo...${colors.reset}\r`);
  const res = await sendEquipmentEmployees(eq, employees);

  section('Resultado do Envio de Funcionários');
  if (res.ok) {
    success(`Enviados com sucesso ${res.count} funcionários para o equipamento via protocolo ${res.manufacturer}!`);

    // Preview table of first few employees
    const rows = employees.slice(0, 8).map((emp) => [
      String(emp.Id),
      emp.Nome,
      emp.Cpf || '-',
      emp.NumeroFolha || '-',
      emp.NumeroPis || '-',
    ]);
    table(['ID', 'Nome do Colaborador', 'CPF', 'Folha', 'PIS'], rows);

    if (employees.length > 8) {
      console.log(`  ${colors.dim}... e mais ${employees.length - 8} colaboradores sincronizados.${colors.reset}`);
    }
  } else {
    printError(`Falha ao transmitir funcionários para o REP via protocolo ${res.manufacturer}: ${res.error}`);
  }
  console.log();
}

/**
 * Send employer details to equipment using its manufacturer protocol.
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.EnviarEmpregador.
 * @param {string|number} id
 */
async function equipmentSendEmployerCommand(id) {
  header('Secullum Cloud — Envio de Dados do Empregador');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('Nenhuma sessão ativa. Execute: secullum-agent-cli login');
    process.exit(1);
  }

  if (!id) {
    printError('Uso: secullum-agent-cli equipment:send-employer <id>');
    process.exit(1);
  }

  let eq;
  try {
    process.stdout.write(`${colors.dim}Consultando equipamento #${id} no Secullum Cloud...${colors.reset}\r`);
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Equipamento Alvo');
  keyValue('Nome', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', `${eq.ip}:${eq.porta}`);

  process.stdout.write(`\n${colors.dim}Obtendo dados cadastrais do empregador na nuvem...${colors.reset}\r`);
  let employer;
  try {
    employer = await fetchEmployer(id);
  } catch (err) {
    printError(`Falha ao obter dados do empregador da nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Dados do Empregador');
  const tipoDocStr = employer.TipoDeDocumento === 1 ? 'CPF' : 'CNPJ';
  keyValue('Razão Social', colors.bold(employer.RazaoSocial));
  keyValue('Tipo de Documento', tipoDocStr);
  keyValue('Documento', employer.Documento);
  keyValue('CEI / CAEPF', employer.Cei || '0');
  keyValue('Local / Endereço', employer.Local);

  process.stdout.write(`\n${colors.dim}Transmitindo dados do empregador para o REP via protocolo nativo...${colors.reset}\r`);
  const res = await sendEquipmentEmployer(eq, employer);

  section('Resultado do Envio');
  if (res.ok) {
    success(`Dados do empregador enviados com sucesso para o equipamento via protocolo ${res.manufacturer} (${res.latencyMs}ms)!`);
  } else {
    printError(`Falha ao transmitir dados do empregador via protocolo ${res.manufacturer}: ${res.error}`);
  }
  console.log();
}

/**
 * Receive employer details from equipment using its manufacturer protocol.
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.ReceberEmpregador.
 * @param {string|number} id
 */
async function equipmentReceiveEmployerCommand(id) {
  header('Secullum Cloud — Consulta de Empregador no REP');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('Nenhuma sessão ativa. Execute: secullum-agent-cli login');
    process.exit(1);
  }

  if (!id) {
    printError('Uso: secullum-agent-cli equipment:get-employer <id>');
    process.exit(1);
  }

  let eq;
  try {
    process.stdout.write(`${colors.dim}Consultando equipamento #${id} no Secullum Cloud...${colors.reset}\r`);
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Equipamento Alvo');
  keyValue('Nome', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', `${eq.ip}:${eq.porta}`);

  process.stdout.write(`\n${colors.dim}Consultando dados do empregador diretamente no REP...${colors.reset}\r`);
  const res = await receiveEquipmentEmployer(eq);

  section('Resultado da Consulta no REP');
  if (res.ok && res.employer) {
    const emp = res.employer;
    const tipoDocStr = emp.TipoDeDocumento === 1 ? 'CPF' : 'CNPJ';
    keyValue('Razão Social', colors.bold(emp.RazaoSocial));
    keyValue('Tipo de Documento', tipoDocStr);
    keyValue('Documento', emp.Documento);
    keyValue('CEI / CAEPF', emp.Cei || '0');
    keyValue('Local / Endereço', emp.Local);
    success(`Empregador obtido com sucesso via protocolo ${res.manufacturer} (${res.latencyMs}ms)!`);
  } else {
    printError(`Falha ao consultar empregador via protocolo ${res.manufacturer}: ${res.error}`);
  }
  console.log();
}

/**
 * Pull enrolled biometric templates from equipment to the Secullum Cloud (ReceberDigitais).
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.ReceberDigitais.
 * @param {string|number} id
 */
async function equipmentReceiveBiometricsCommand(id) {
  header('Secullum Cloud — Puxar Digitais do Equipamento (ReceberDigitais)');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('Nenhuma sessão ativa. Execute: secullum-agent-cli login');
    process.exit(1);
  }

  if (!id) {
    printError('Uso: secullum-agent-cli equipment:receive-biometrics <id>');
    process.exit(1);
  }

  let eq;
  try {
    process.stdout.write(`${colors.dim}Consultando equipamento #${id} no Secullum Cloud...${colors.reset}\r`);
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  section('Equipamento Alvo');
  keyValue('Nome', colors.bold(eq.descricao));
  keyValue('Tipo / Modelo', eq.tipo);
  keyValue('Endereço IP', `${eq.ip}:${eq.porta}`);

  process.stdout.write(`\n${colors.dim}Carregando lista de colaboradores da nuvem...${colors.reset}\r`);
  let employees = [];
  try {
    employees = await fetchEmployees();
  } catch (err) {
    printError(`Falha ao obter lista de funcionários da nuvem: ${err.message}`);
    process.exit(1);
  }

  keyValue('Colaboradores na Nuvem', `${employees.length} cadastrados`);

  section('Extração de Digitais do REP');
  process.stdout.write(`${colors.dim}Iniciando varredura biométrica via protocolo nativo...${colors.reset}\n`);

  let lastMsg = '';
  const onProgress = (current, total, empName) => {
    const pct = Math.round((current / total) * 100);
    const msg = `[${pct}%] Consultando digital ${current}/${total}: ${empName}`;
    if (msg !== lastMsg) {
      lastMsg = msg;
      process.stdout.write(`\r${colors.cyan}${msg.padEnd(70)}${colors.reset}`);
    }
  };

  const res = await receiveEquipmentBiometrics(eq, employees, onProgress);
  process.stdout.write('\r' + ' '.repeat(75) + '\r');

  if (!res.ok) {
    printError(`Falha ao receber digitais via protocolo ${res.manufacturer}: ${res.error}`);
    console.log();
    return;
  }

  section('Digitais Coletadas no REP');
  keyValue('Protocolo do Fabricante', res.manufacturer);
  keyValue('Tempo de Resposta', `${res.latencyMs}ms`);
  keyValue('Total de Digitais Encontradas', colors.bold(String(res.count)));

  if (res.biometrics.length > 0) {
    const rows = res.biometrics.map((b) => [
      String(b.PessoaId || '-'),
      b.Nome || '-',
      `Dedo #${b.Dedo}`,
      b.Template ? `${Math.round((Buffer.from(b.Template, 'base64').length))} B` : '0 B',
      b.TemplateCodigo || '-',
    ]);

    table(['ID Pessoa', 'Colaborador', 'Dedo', 'Tamanho', 'Código'], rows);

    section('Sincronização com a Nuvem (Secullum Cloud)');
    process.stdout.write(`${colors.dim}Transmitindo digitais para o SignalR Hub do Secullum Cloud...${colors.reset}\r`);

    const upRes = await uploadBiometrics(id, res.biometrics, res.tipoBiometria);
    if (upRes.ok) {
      success(`Sincronização concluída com sucesso! ${res.count} biometria(s) atualizada(s) na nuvem do Secullum.`);
    } else {
      printError(`Falha ao enviar digitais para a nuvem: ${upRes.error}`);
    }
  } else {
    info('Nenhuma impressão digital cadastrada foi encontrada no equipamento para os colaboradores consultados.');
  }
  console.log();
}

module.exports = {
  equipmentListCommand,
  equipmentAddCommand,
  equipmentRemoveCommand,
  equipmentTestCommand,
  equipmentSyncTimeCommand,
  equipmentCollectCommand,
  equipmentSendEmployeesCommand,
  equipmentSendEmployerCommand,
  equipmentReceiveEmployerCommand,
  equipmentReceiveBiometricsCommand,
};

