/**
 * commands/biometric.js - CLI Commands for Desktop USB Biometric Readers.
 * Replicates the official Electron app reader selection & status features.
 * Zero external dependencies.
 */

'use strict';

const {
  BIOMETRIC_READERS,
  detectBiometricReaders,
  getBiometricStatus,
  selectBiometricReader,
} = require('../biometric');
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
 * Show current biometric reader status and catalog.
 */
async function biometricStatusCommand() {
  header('Secullum — Leitor Biométrico USB de Mesa');

  const status = getBiometricStatus();

  section('Configuração Atual');
  keyValue('Leitor Selecionado', colors.bold(status.nome));
  if (status.id === -1) {
    keyValue('Estado', `${colors.dim}Desativado${colors.reset}`);
  } else if (status.conectado) {
    keyValue('Estado', `${colors.green}${symbols.check} Conectado via USB${colors.reset}`);
    if (status.hardwareDevice) {
      keyValue('Dispositivo', status.hardwareDevice.name);
      keyValue('ID Hardware', `VID_${status.hardwareDevice.vid}&PID_${status.hardwareDevice.pid}`);
    }
  } else {
    keyValue('Estado', `${colors.red}${symbols.cross} Desconectado (dispositivo USB não detectado)${colors.reset}`);
  }

  // Reader Catalog Table
  section('Modelos Homologados');
  const rows = BIOMETRIC_READERS.map((r) => {
    const isSelected = r.id === status.id;
    const selectedMark = isSelected ? `${colors.green}${symbols.check} Ativo${colors.reset}` : `${colors.dim}-${colors.reset}`;
    return [
      String(r.id),
      r.nome,
      r.manufacturer,
      selectedMark,
    ];
  });

  table(['ID', 'Modelo', 'Fabricante', 'Selecionado'], rows);

  console.log(`\n${colors.dim}Comandos disponíveis:${colors.reset}`);
  console.log(`  ${colors.bold('secullum-agent-cli biometric:select <id>')}  (Definir leitor ativo)`);
  console.log(`  ${colors.bold('secullum-agent-cli biometric:scan')}         (Detectar leitores conectados na USB)\n`);
}

/**
 * Scan USB ports for connected biometric readers.
 */
async function biometricScanCommand() {
  header('Secullum — Escanear Dispositivos USB');

  process.stdout.write(`${colors.dim}Escaneando portas USB do computador...${colors.reset}\r`);
  const detected = detectBiometricReaders();

  if (detected.length === 0) {
    warn('Nenhum leitor biométrico homologado foi detectado nas portas USB.');
    console.log(`\n${colors.dim}Verifique se o cabo USB está firmemente conectado e se os drivers estão instalados.${colors.reset}\n`);
    return;
  }

  success(`Detectado(s) ${detected.length} leitor(es) biométrico(s) conectado(s):`);

  const rows = detected.map((d) => [
    String(d.reader.id),
    d.reader.nome,
    d.reader.manufacturer,
    d.device.name,
    `VID_${d.device.vid}&PID_${d.device.pid}`,
  ]);

  table(['ID', 'Modelo Homologado', 'Fabricante', 'Dispositivo USB', 'Hardware ID'], rows);

  console.log(`\n${colors.dim}Para ativar um dos leitores detectados:${colors.reset}`);
  console.log(`  ${colors.bold(`secullum-agent-cli biometric:select ${detected[0].reader.id}`)}\n`);
}

/**
 * Select active biometric reader by ID.
 * @param {string|number} id
 */
async function biometricSelectCommand(id) {
  if (id === undefined || id === null || id === '') {
    printError('ID do leitor é obrigatório. Exemplo: secullum-agent-cli biometric:select 0');
    console.log(`\nIDs válidos: ${BIOMETRIC_READERS.map((r) => `${r.id} (${r.nome})`).join(', ')}\n`);
    process.exit(1);
  }

  try {
    const res = selectBiometricReader(Number(id));
    header('Secullum — Selecionar Leitor Biométrico');
    success(`Leitor biométrico configurado como: ${colors.bold(res.reader.nome)} (ID: ${res.reader.id})`);
    console.log();
  } catch (err) {
    printError(err.message);
    process.exit(1);
  }
}

/**
 * Interactively capture fingerprint from desktop USB biometric reader.
 * @param {string|number} [personId]
 */
async function biometricCaptureCommand(personId) {
  header('Secullum — Captura Ativa de Biometria (Leitor de Mesa)');

  const status = getBiometricStatus();
  if (status.id === -1) {
    warn('O leitor biométrico está atualmente "Desativado".');
    console.log(`\n${colors.dim}Selecione um leitor antes de capturar:${colors.reset}`);
    console.log(`  ${colors.bold('secullum-agent-cli biometric:select 0')}  (Suprema BioMini)`);
    console.log(`  ${colors.bold('secullum-agent-cli biometric:select 16')} (Control iD iDBio)\n`);
    process.exit(1);
  }

  const { captureBiometric } = require('../biometric');

  section('Status do Dispositivo');
  keyValue('Leitor Ativo', colors.bold(status.nome));
  if (status.conectado) {
    keyValue('Porta USB', `${colors.green}${symbols.check} Conectado (${status.hardwareDevice.name})${colors.reset}`);
  } else {
    keyValue('Porta USB', `${colors.yellow}${symbols.bullet} Emulação de sensor ativa (Hardware USB desconectado)${colors.reset}`);
  }
  if (personId) {
    keyValue('ID da Pessoa/Funcionário', String(personId));
  }

  console.log(`\n${colors.cyan}${symbols.bullet} Iniciando processo de captura biométrica...${colors.reset}\n`);

  const progressBar = (percent, message) => {
    const totalBars = 25;
    const filled = Math.round((percent / 100) * totalBars);
    const empty = totalBars - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    process.stdout.write(`\r  [${colors.green}${bar}${colors.reset}] ${String(percent).padStart(3)}% - ${colors.bold(message)}`);
  };

  try {
    const result = await captureBiometric({
      readerId: status.id,
      pessoaId: personId ? Number(personId) : 0,
      dedo: 1, // Indicador Direito
      onProgress: (p) => progressBar(p.percent, p.message),
    });

    console.log('\n');
    section('Resultado da Captura Biometria');
    success('Minúcias biométricas extraídas com sucesso!');
    keyValue('Leitor Utilizado', result.readerName);
    keyValue('Qualidade do Dedo', `${colors.bold(colors.green(`${result.Qualidade}%`))} (Excelente)`);
    keyValue('Dedo Referência', '1 (Indicador Direito)');
    keyValue('Pessoa ID', String(result.PessoaId || 'Não vinculado'));
    keyValue('Formato Template', 'ANSI/ISO 378 (Base64)');
    keyValue('Tamanho Template', `${Math.round(result.Template.length * 0.75)} bytes`);
    keyValue('Hash da Digital (SHA-256)', colors.dim(result.TemplateCodigo));

    console.log(`\n${colors.dim}Quando o agente estiver rodando ('secullum-agent-cli connect'), as capturas solicitadas pelo PontoWeb serão transmitidas automaticamente para a nuvem via SignalR.${colors.reset}\n`);
  } catch (err) {
    console.log();
    printError(`Falha na captura biométrica: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  biometricStatusCommand,
  biometricScanCommand,
  biometricSelectCommand,
  biometricCaptureCommand,
};

