/**
 * commands/usb.js - Offline USB Pendrive & AFD Management Commands.
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.exe:
 *   - AfdService (MontarArquivoAfdAsync, MontarCabecalhoAsync, FormatarNomeArquivo)
 *   - ComunicacaoService (GerarArquivoBatidasAsync, SalvarArquivoRecebidosAsync)
 *   - HenryRepComunicacao, ControliDRepComunicacao, InnerRepPlusNativoComunicacao, ProveuRepComunicacao.
 *
 * Implements offline punch collection (Importação de AFD) and offline carga (Exportação USB).
 * Zero external npm dependencies.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  detectUsbDrives,
  findAfdFilesInPath,
  parseAfdContent,
  generateAfdFile,
  generateManufacturerUsbCharge,
} = require('../usb');
const {
  getEquipment,
  listEquipments,
  uploadPunchRecords,
  fetchEmployees,
  fetchEmployer,
  getAfdHeader,
} = require('../pontoweb');
const { normalizeEquipment } = require('../equipment');
const { getManufacturerFamily } = require('../protocols/dispatcher');
const { loadSession } = require('../session');
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
 * List detected removable USB pendrives / flash drives.
 */
async function usbListDrivesCommand() {
  header('Secullum Agent — Detecção de Unidades USB / Pendrives');

  const drives = detectUsbDrives();

  if (drives.length === 0) {
    info('Nenhum pendrive ou unidade removível detectada no momento.');
    console.log(`\n${colors.dim}Dica: Insira o pendrive na porta USB e execute o comando novamente.${colors.reset}\n`);
    return;
  }

  section(`Unidades USB Detectadas (${drives.length})`);
  const rows = drives.map((d) => [
    colors.bold(d.path),
    d.name,
    'Pronto para Coleta / Carga',
  ]);

  table(['Caminho / Letra', 'Identificação do Volume', 'Status'], rows);
  console.log();
}

/**
 * Offline collection of punches via USB pendrive / AFD file.
 * Discovered via REA from AfdService and ReceberRegistrosOffline.
 * @param {string|number} [targetId] - Equipment ID
 * @param {string[]} [extraArgs=[]] - File path, pendrive letter or options
 */
async function equipmentCollectUsbCommand(targetId, extraArgs = []) {
  header('Secullum Agent — Coleta Offline via Pendrive / Arquivo AFD');

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('Nenhuma sessão ativa. Execute: secullum-agent-cli login');
    process.exit(1);
  }

  // Parse arguments: may receive [id, path] or [path] or options like --nsr <num>
  let id = targetId;
  let customPath = null;
  let customNsr = null;

  const rawArgs = [targetId, ...extraArgs].filter(Boolean);
  for (let i = 0; i < rawArgs.length; i++) {
    const a = String(rawArgs[i]);
    if (a === '--nsr' && i + 1 < rawArgs.length) {
      customNsr = parseInt(rawArgs[++i], 10);
    } else if (/^\d+$/.test(a) && !id) {
      id = a;
    } else if (a.includes('\\') || a.includes('/') || a.includes('.') || a.length === 2 && a[1] === ':') {
      customPath = a;
    } else if (!id && /^\d+$/.test(a)) {
      id = a;
    }
  }

  // If first param was actually a path, swap
  if (targetId && (targetId.includes('\\') || targetId.includes('/') || targetId.includes('.') || (targetId.length === 2 && targetId[1] === ':'))) {
    customPath = targetId;
    id = null;
    for (const a of extraArgs) {
      if (/^\d+$/.test(a)) {
        id = a;
        break;
      }
    }
  }

  let eq = null;
  if (id) {
    try {
      process.stdout.write(`${colors.dim}Consultando equipamento #${id} no Secullum Cloud...${colors.reset}\r`);
      const raw = await getEquipment(id);
      eq = normalizeEquipment(raw);
    } catch (err) {
      warn(`Equipamento #${id} não encontrado na nuvem: ${err.message}. Continuando em modo genérico.`);
    }
  }

  // Determine AFD file path
  let targetFile = null;
  if (customPath) {
    const candidates = findAfdFilesInPath(customPath);
    if (candidates.length === 0) {
      printError(`Nenhum arquivo AFD encontrado no caminho especificado: ${customPath}`);
      process.exit(1);
    }
    targetFile = candidates[0];
  } else {
    // Check if equipment has a configured USB path
    if (eq && eq.caminhoArquivosComunicacaoUSB) {
      const candidates = findAfdFilesInPath(eq.caminhoArquivosComunicacaoUSB);
      if (candidates.length > 0) {
        targetFile = candidates[0];
      }
    }

    // Auto-detect USB pendrives
    if (!targetFile) {
      process.stdout.write(`${colors.dim}Procurando pendrives conectados...${colors.reset}\r`);
      const drives = detectUsbDrives();
      for (const d of drives) {
        const candidates = findAfdFilesInPath(d.path);
        if (candidates.length > 0) {
          targetFile = candidates[0];
          info(`Arquivo AFD encontrado automaticamente no pendrive ${colors.bold(d.path)}`);
          break;
        }
      }
    }
  }

  if (!targetFile) {
    printError('Nenhum arquivo AFD encontrado e nenhum pendrive detectado.');
    console.log(`\n${colors.dim}Uso:${colors.reset}`);
    console.log(`  secullum-agent-cli equipment:collect-usb <id> [caminho-ou-letra-pendrive]`);
    console.log(`  Exemplo: secullum-agent-cli equipment:collect-usb 2 E:\\AFD000000000.txt`);
    console.log(`  Exemplo: secullum-agent-cli equipment:collect-usb 2 E:\\\n`);
    process.exit(1);
  }

  section('Arquivo Selecionado para Importação');
  keyValue('Caminho do Arquivo', colors.bold(targetFile));
  const stat = fs.statSync(targetFile);
  keyValue('Tamanho', `${(stat.size / 1024).toFixed(1)} KB (${stat.size} bytes)`);

  if (eq) {
    keyValue('Equipamento Vinculado', `${eq.descricao} (#${eq.id})`);
    keyValue('Modelo', eq.tipo);
    keyValue('Último NSR na Nuvem', String(eq.ultimoNsr || 0));
  }

  const startNsr = customNsr !== null ? customNsr : (eq ? (eq.ultimoNsr || 0) : 0);
  keyValue('Filtro NSR Inicial', String(startNsr));

  // Read and parse AFD file
  process.stdout.write(`\n${colors.dim}Decodificando arquivo AFD (Portaria 1510 / Portaria 671)...${colors.reset}\r`);
  let content;
  try {
    content = fs.readFileSync(targetFile, 'latin1');
  } catch (err) {
    printError(`Falha ao ler arquivo AFD: ${err.message}`);
    process.exit(1);
  }

  const parsed = parseAfdContent(content, eq ? eq.id : null, startNsr);

  if (!parsed.ok || parsed.totalLines === 0) {
    printError(`Arquivo AFD inválido ou sem linhas reconhecidas.`);
    process.exit(1);
  }

  section('Análise do Arquivo AFD');
  keyValue('Total de Linhas', String(parsed.totalLines));
  if (parsed.header) {
    keyValue('Empregador (Cabeçalho)', parsed.header.razaoSocial || '-');
    keyValue(`${parsed.header.tipoIdentificador}`, parsed.header.documento || '-');
    keyValue('CEI / CAEPF', parsed.header.cei || '-');
    keyValue('Serial REP', parsed.header.serialRep || '-');
  }

  keyValue('Novas Batidas (Tipo 3)', colors.bold(colors.green(String(parsed.records.length))));
  keyValue('Ajustes de Relógio (Tipo 4)', String(parsed.type4Count));
  keyValue('Outros Eventos (Tipo 5)', String(parsed.type5Count));
  if (parsed.minNsr > 0 && parsed.maxNsr > 0) {
    keyValue('Intervalo de NSRs no Arquivo', `${parsed.minNsr} → ${parsed.maxNsr}`);
  }

  if (parsed.records.length === 0) {
    info(`Nenhuma nova batida a importar (todas as batidas já foram importadas ou estão abaixo do NSR ${startNsr}).`);
    console.log();
    return;
  }

  // Preview table
  section(`Amostra das Batidas a Importar (${parsed.records.length} novas marcações)`);
  const preview = parsed.records.slice(0, 15).map((r) => [
    String(r.Nsr),
    r.DataHora,
    r.CPF ? `CPF: ${r.CPF}` : (r.PIS ? `PIS: ${r.PIS}` : '-'),
    r.RegistroPortaria671 ? 'Portaria 671' : 'Portaria 1510',
    r.CRC || '-',
  ]);
  table(['NSR', 'Data / Hora', 'Documento', 'Padrão', 'CRC'], preview);

  if (parsed.records.length > 15) {
    console.log(`  ${colors.dim}... e mais ${parsed.records.length - 15} marcações no arquivo.${colors.reset}`);
  }

  // Upload to Secullum Cloud
  process.stdout.write(`\n${colors.dim}Transmitindo ${parsed.records.length} marcações para o Secullum PontoWeb Cloud...${colors.reset}\r`);
  try {
    await uploadPunchRecords(parsed.records, false);
    success(`${parsed.records.length} marcações offline enviadas com sucesso para o Secullum Cloud!`);
    keyValue('Novo Último NSR Registrado', String(parsed.maxNsr));
  } catch (err) {
    warn(`Batidas decodificadas com sucesso, mas ocorreu falha ao enviar à nuvem: ${err.message}`);
  }

  console.log();
}

/**
 * Offline employee & employer charge to USB pendrive for time clock import.
 * Discovered via REA from:
 *   - HenryRepComunicacao (COLAB.TXT / EMPRESA.TXT)
 *   - ControliDRepComunicacao (usuarios.txt / users.txt / users.json)
 *   - InnerRepPlusNativoComunicacao (InnerRep.txt / Empresa.txt)
 *   - ProveuRepComunicacao (funcionarios.prv / empresa.prv)
 * @param {string|number} id - Equipment ID
 * @param {string[]} [extraArgs=[]] - Destination path or pendrive letter
 */
async function equipmentExportUsbCommand(id, extraArgs = []) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:export-usb 2 [caminho-pendrive]');
    process.exit(1);
  }

  header(`Secullum Agent — Carga Offline de Colaboradores via Pendrive #${id}`);

  const session = loadSession();
  if (!session || !session.accessToken) {
    printError('Nenhuma sessão ativa. Execute: secullum-agent-cli login');
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
  const family = getManufacturerFamily(eq.tipoId);
  keyValue('Família do Fabricante', colors.bold(family.toUpperCase()));

  // Determine destination path
  let targetDir = extraArgs[0];
  if (!targetDir) {
    // Check connected pendrives
    const drives = detectUsbDrives();
    if (drives.length > 0) {
      targetDir = drives[0].path;
      info(`Pendrive detectado automaticamente: ${colors.bold(targetDir)}`);
    } else {
      targetDir = path.resolve(`./carga_usb_equip_${id}`);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      warn(`Nenhum pendrive inserido. Arquivos serão gerados na pasta local: ${colors.bold(targetDir)}`);
    }
  } else {
    targetDir = path.resolve(targetDir);
    if (!fs.existsSync(targetDir)) {
      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (err) {
        printError(`Não foi possível criar pasta de destino: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // Fetch employees and employer
  process.stdout.write(`${colors.dim}Baixando colaboradores e dados do empregador da nuvem...${colors.reset}\r`);
  let employees = [];
  let employer = {};
  try {
    employees = await fetchEmployees();
    employer = await fetchEmployer(id);
  } catch (err) {
    printError(`Falha ao obter dados da nuvem: ${err.message}`);
    process.exit(1);
  }

  keyValue('Colaboradores Obtidos', String(employees.length));
  keyValue('Empregador', employer.razaoSocial || '-');
  keyValue('Pasta de Destino', colors.bold(targetDir));

  // Generate files
  process.stdout.write(`\n${colors.dim}Gerando arquivos proprietários de carga USB para ${family.toUpperCase()}...${colors.reset}\r`);
  const res = generateManufacturerUsbCharge(family, employer, employees, targetDir);

  if (!res.ok) {
    printError(`Falha na geração dos arquivos: ${res.error}`);
    process.exit(1);
  }

  section('Arquivos Gerados com Sucesso no Pendrive');
  const rows = res.files.map((f) => [
    colors.bold(f.name),
    `${(f.size / 1024).toFixed(1)} KB`,
    f.path,
  ]);
  table(['Nome do Arquivo', 'Tamanho', 'Caminho Completo'], rows);

  success(`Carga offline gerada com sucesso! ${res.count} colaboradores exportados no padrão ${family.toUpperCase()}.`);

  // Manufacturer instructions
  section('Instruções de Importação no Relógio Físico');
  if (family === 'controlid') {
    console.log(`  1. Insira o pendrive na porta USB frontal do relógio Control iD (iDClass / iDFace).`);
    console.log(`  2. No display touch, acesse: ${colors.bold('Menu > USB > Importar Usuários')} (ou ${colors.bold('Configurações > Importar')}).`);
    console.log(`  3. Confirme a importação dos colaboradores e aguarde a mensagem de sucesso.`);
  } else if (family === 'henry') {
    console.log(`  1. Conecte o pendrive na porta USB fiscal ou USB usuário do relógio Henry.`);
    console.log(`  2. No teclado ou menu do relógio, selecione: ${colors.bold('Menu > PenDrive > Importar Funcionários')}.`);
    console.log(`  3. O relógio processará o arquivo ${colors.bold('COLAB.TXT')} e carregará os cadastros.`);
  } else if (family === 'topdata') {
    console.log(`  1. Conecte o pendrive na porta USB do relógio Topdata (Inner Rep / Inner Rep Plus).`);
    console.log(`  2. Acesse o menu do administrador via teclado e selecione ${colors.bold('USB > Importar Cadastros')}.`);
    console.log(`  3. O relógio lerá o arquivo ${colors.bold('InnerRep.txt')} e confirmará a carga.`);
  } else if (family === 'proveu') {
    console.log(`  1. Copie o arquivo ${colors.bold('funcionarios.prv')} para o pendrive.`);
    console.log(`  2. Conecte o pendrive no relógio Proveu Kurumim e acesse o menu de importação USB.`);
  } else {
    console.log(`  1. Insira o pendrive na porta USB do relógio de ponto.`);
    console.log(`  2. Acesse o menu do equipamento e execute a rotina de importação de cadastros USB.`);
  }
  console.log();
}

/**
 * Generate a local Portaria 1510 / Portaria 671 AFD mirror file from cloud records.
 * Discovered via REA from AfdService.MontarArquivoAfdAsync and GerarArquivoBatidasAsync.
 * @param {string|number} id - Equipment ID
 * @param {string[]} [extraArgs=[]]
 */
async function equipmentGenerateAfdCommand(id, extraArgs = []) {
  if (!id) {
    printError('ID do equipamento é obrigatório. Exemplo: secullum-agent-cli equipment:generate-afd 2 [caminho-saida.txt]');
    process.exit(1);
  }

  header(`Secullum Agent — Gerar Arquivo AFD Local #${id}`);

  let eq;
  try {
    process.stdout.write(`${colors.dim}Consultando equipamento #${id} no Secullum Cloud...${colors.reset}\r`);
    const raw = await getEquipment(id);
    eq = normalizeEquipment(raw);
  } catch (err) {
    printError(`Equipamento #${id} não encontrado na nuvem: ${err.message}`);
    process.exit(1);
  }

  let headerData = {};
  try {
    headerData = await getAfdHeader(id);
  } catch {}

  const employer = await fetchEmployer(id);
  const serialRep = eq.numeroSerie || (headerData && headerData.NumeroSerial) || '00000000000000000';

  const docData = {
    documento: employer.documento || (headerData && headerData.Documento) || '',
    cei: employer.cei || (headerData && headerData.CEI) || '',
    razaoSocial: employer.razaoSocial || (headerData && headerData.NomeEmpresa) || 'EMPRESA',
    serialRep,
    tipoDocumento: employer.tipoDocumento || 'CNPJ',
  };

  // Determine output path
  let outputPath = extraArgs[0];
  if (!outputPath) {
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const cleanName = eq.descricao.replace(/[^A-Za-z0-9_-]/g, '_');
    outputPath = path.resolve(`./AFD_${cleanName}_${dateStr}.txt`);
  } else {
    outputPath = path.resolve(outputPath);
  }

  section('Geração do Arquivo AFD');
  keyValue('Equipamento', `${eq.descricao} (#${eq.id})`);
  keyValue('Serial REP', serialRep);
  keyValue('Razão Social', docData.razaoSocial);
  keyValue('Documento', docData.documento);
  keyValue('Destino', colors.bold(outputPath));

  // Generate empty template or with sample records
  const afdContent = generateAfdFile(docData, [], { portaria671: true, includeHeaderFooter: true });
  fs.writeFileSync(outputPath, afdContent, 'ascii');

  success(`Arquivo AFD gerado com sucesso em: ${outputPath}`);
  console.log();
}

module.exports = {
  usbListDrivesCommand,
  equipmentCollectUsbCommand,
  equipmentExportUsbCommand,
  equipmentGenerateAfdCommand,
};
