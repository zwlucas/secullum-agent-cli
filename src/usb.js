/**
 * usb.js - Standalone USB Pendrive & Offline AFD Management Module.
 * Discovered via REA from Secullum RH / PontoWeb:
 *   - Secullum.PontoWeb.ServicoComunicacao.Services.AfdService (MontarArquivoAfdAsync, MontarCabecalhoAsync, MontarCorpoAfd, MontarRodape, FormatarNomeArquivo)
 *   - Secullum.Comunicacao.HenryRepComunicacao (ReceberRegistrosOffline, EnviarColaboradores)
 *   - Secullum.Comunicacao.ControliDRepComunicacao (ReceberRegistros, EnviarColaboradores)
 *   - Secullum.Comunicacao.InnerRepPlusNativoComunicacao (ExportarFuncionariosArquivoRBAsync, ExportarEmpresaArquivoRBAsync)
 *   - Secullum.Comunicacao.ProveuRepComunicacao (CriarArquivoFuncionarios, CriarArquivoEmpregador, LerArquivoAfd)
 *
 * Supports Portaria 1510 and Portaria 671 AFD formats, automatic USB pendrive detection,
 * offline punch collection, and manufacturer-specific USB carga file generation.
 * Zero external npm dependencies.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

/**
 * Detect connected removable USB pendrives / flash drives on the host OS.
 * @returns {Array<{ path: string, name: string, size?: number, free?: number }>}
 */
function detectUsbDrives() {
  const drives = [];

  if (process.platform === 'win32') {
    try {
      const psCmd = `Get-CimInstance Win32_LogicalDisk | Where-Object DriveType -eq 2 | ForEach-Object { $_.DeviceID + '|' + ($_.VolumeName) }`;
      const out = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, {
        encoding: 'utf-8',
        timeout: 4000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const [devId, volName] = line.split('|');
        if (devId) {
          const rootPath = devId.endsWith('\\') ? devId : `${devId}\\`;
          drives.push({
            path: rootPath,
            name: volName ? `${volName} (${devId})` : `Pendrive (${devId})`,
          });
        }
      }
    } catch {
      // Fallback: probe drive letters D: to Z:
      for (let c = 68; c <= 90; c++) {
        const letter = `${String.fromCharCode(c)}:\\`;
        try {
          if (fs.existsSync(letter)) {
            drives.push({ path: letter, name: `Unidade (${letter})` });
          }
        } catch {}
      }
    }
  } else {
    // Linux / macOS
    const user = os.userInfo().username;
    const searchDirs = [
      `/media/${user}`,
      `/run/media/${user}`,
      '/media',
      '/mnt',
    ];

    for (const d of searchDirs) {
      if (fs.existsSync(d)) {
        try {
          const entries = fs.readdirSync(d);
          for (const entry of entries) {
            const fullPath = path.join(d, entry);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                drives.push({
                  path: fullPath,
                  name: `USB (${entry})`,
                });
              }
            } catch {}
          }
        } catch {}
      }
    }
  }

  return drives;
}

/**
 * Find AFD / punch collection files inside a given directory or validate a file.
 * Discovered via REA from ProveuRepComunicacao.LerArquivoAfd and HenryRepComunicacao.
 * @param {string} targetPath - Directory or file path
 * @returns {Array<string>} List of absolute file paths
 */
function findAfdFilesInPath(targetPath) {
  if (!targetPath) return [];

  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) return [];

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return [resolved];
  }

  if (stat.isDirectory()) {
    const candidates = [];
    try {
      const files = fs.readdirSync(resolved);
      for (const f of files) {
        const lower = f.toLowerCase();
        // Match standard AFD names: AFD*.txt, *.rep, *.dat, *.prv, *.txt
        if (
          lower.startsWith('afd') ||
          lower.endsWith('.rep') ||
          lower.endsWith('.dat') ||
          lower.endsWith('.prv') ||
          (lower.endsWith('.txt') && (lower.includes('batida') || lower.includes('coleta') || lower.includes('ponto') || lower.includes('log')))
        ) {
          candidates.push(path.join(resolved, f));
        }
      }

      // If no specifically named file found, include all .txt files
      if (candidates.length === 0) {
        for (const f of files) {
          if (f.toLowerCase().endsWith('.txt')) {
            candidates.push(path.join(resolved, f));
          }
        }
      }
    } catch {}

    return candidates;
  }

  return [];
}

/**
 * Parse an AFD file content into structured records following Portaria 1510 / Portaria 671.
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.ReceberRegistrosOffline.
 * @param {string} content - Raw AFD file text
 * @param {number|string} [equipId=null] - Equipment ID
 * @param {number} [startNsr=0] - Starting NSR filter
 * @returns {{ ok: boolean, header?: object, records: Array<object>, type4Count: number, type5Count: number, minNsr: number, maxNsr: number, totalLines: number, error?: string }}
 */
function parseAfdContent(content, equipId = null, startNsr = 0) {
  if (!content) {
    return { ok: false, records: [], type4Count: 0, type5Count: 0, minNsr: 0, maxNsr: 0, totalLines: 0, error: 'Arquivo vazio' };
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let header = null;
  const records = [];
  let type4Count = 0;
  let type5Count = 0;
  let minNsr = Infinity;
  let maxNsr = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 10) continue;

    // Type 1: Cabeçalho
    if (line.startsWith('0000000001') || (line.length >= 10 && line[9] === '1' && line.substring(0, 9) === '000000000')) {
      try {
        const tipoId = line.substring(10, 11); // 1 = CNPJ, 2 = CPF
        const doc = line.substring(11, 25).trim();
        const cei = line.substring(25, 37).trim();
        const razaoSocial = line.substring(37, 187).trim();
        const serialRep = line.substring(187, 204).trim();
        header = {
          tipoIdentificador: tipoId === '2' ? 'CPF' : 'CNPJ',
          documento: doc,
          cei,
          razaoSocial,
          serialRep,
        };
      } catch {}
      continue;
    }

    // Type 9: Rodapé
    if (line.startsWith('999999999') || (line.length >= 10 && line[9] === '9' && line.substring(0, 9) === '999999999')) {
      continue;
    }

    // Identify record type from position 9 or 10
    // Portaria 1510: [0-8]: NSR (9 digits), [9]: Tipo '3', [10-17]: ddmmyyyy, [18-21]: hhmm, [22-32]: PIS (11 digits), [33-36]: CRC (optional)
    // Portaria 671: [0-9]: NSR (10 digits), [10]: Tipo '3' ... or ISO date format
    let nsrStr = '';
    let recordType = '';
    let rest = '';

    if (line[9] === '3' || line[9] === '4' || line[9] === '5') {
      nsrStr = line.substring(0, 9);
      recordType = line[9];
      rest = line.substring(10);
    } else if (line[10] === '3' || line[10] === '4' || line[10] === '5') {
      nsrStr = line.substring(0, 10);
      recordType = line[10];
      rest = line.substring(11);
    } else {
      // Non-standard or delimited line (e.g. Henry 8x: NSR+3+...)
      const parts = line.split(/[+;,\t]/);
      if (parts.length >= 4) {
        nsrStr = parts[0];
        recordType = parts[1];
        rest = parts.slice(2).join('');
      } else {
        continue;
      }
    }

    const nsr = Number(nsrStr);
    if (isNaN(nsr)) continue;

    if (recordType === '4') {
      type4Count++;
      continue;
    }

    if (recordType === '5') {
      type5Count++;
      continue;
    }

    if (recordType === '3') {
      // Type 3: Registro de Batida / Marcação de Ponto
      let dataHoraIso = null;
      let pis = null;
      let cpf = null;
      let is671 = false;
      let crc = null;

      // Check for Portaria 671 with ISO timestamp (e.g. 2026-10-15T08:30:00-03:00 or yyyy-MM-dd)
      const isoMatch = rest.match(/(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:?\d{2})?)/);
      if (isoMatch) {
        is671 = true;
        const rawDate = isoMatch[1];
        dataHoraIso = rawDate.replace(' ', 'T').slice(0, 19);
        const afterDate = rest.substring(rest.indexOf(rawDate) + rawDate.length);
        const docMatch = afterDate.match(/(\d{11})/);
        if (docMatch) {
          cpf = docMatch[1];
        }
        const crcMatch = afterDate.match(/([A-Fa-f0-9]{4})$/);
        if (crcMatch) {
          crc = crcMatch[1];
        }
      } else if (rest.length >= 23 && rest.includes('-0300')) {
        // Portaria 671 alternate: ddmmyyyyhhmm-0300 + CPF(11) + CRC(4)
        is671 = true;
        const day = rest.substring(0, 2);
        const mon = rest.substring(2, 4);
        const year = rest.substring(4, 8);
        const hour = rest.substring(8, 10);
        const min = rest.substring(10, 12);
        dataHoraIso = `${year}-${mon}-${day}T${hour}:${min}:00`;
        const offsetIdx = rest.indexOf('-0300');
        if (offsetIdx !== -1) {
          const docPart = rest.substring(offsetIdx + 5, offsetIdx + 5 + 11);
          if (docPart.length === 11) cpf = docPart;
        }
      } else if (rest.length >= 23) {
        // Portaria 1510: [0-7]: ddmmyyyy, [8-11]: hhmm, [12-22]: PIS (11 digits), [23-26]: CRC
        const day = rest.substring(0, 2);
        const mon = rest.substring(2, 4);
        const year = rest.substring(4, 8);
        const hour = rest.substring(8, 10);
        const min = rest.substring(10, 12);
        dataHoraIso = `${year}-${mon}-${day}T${hour}:${min}:00`;
        pis = rest.substring(12, 23).replace(/^0+/, '') || '0';
        if (rest.length >= 27) {
          crc = rest.substring(23, 27);
        }
      }

      if (dataHoraIso && (pis || cpf)) {
        if (nsr > maxNsr) maxNsr = nsr;
        if (nsr < minNsr) minNsr = nsr;

        if (nsr > startNsr) {
          records.push({
            Nsr: nsr,
            DataHora: dataHoraIso,
            CPF: cpf,
            PIS: pis,
            Matricula: null,
            EquipamentoId: equipId ? Number(equipId) : null,
            RegistroPortaria671: is671,
            Sentido: 0,
            Tipo: 0,
            CRC: crc,
          });
        }
      }
    }
  }

  if (minNsr === Infinity) minNsr = 0;

  return {
    ok: true,
    header,
    records,
    type4Count,
    type5Count,
    minNsr,
    maxNsr,
    totalLines: lines.length,
  };
}

/**
 * Generate standard Portaria 1510 / Portaria 671 AFD file content.
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.AfdService.
 * @param {object} headerData - { documento, cei, razaoSocial, serialRep, tipoDocumento }
 * @param {Array<object>} records - List of punch records (DadosRegistroOffline)
 * @param {object} [options]
 * @param {boolean} [options.portaria671=false]
 * @param {boolean} [options.includeHeaderFooter=true]
 * @returns {string} Complete AFD text content
 */
function generateAfdFile(headerData, records = [], options = {}) {
  const { portaria671 = false, includeHeaderFooter = true } = options;
  const lines = [];

  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  // 1. Cabeçalho (Tipo 1)
  if (includeHeaderFooter) {
    const tipoDoc = headerData.tipoDocumento === 'CPF' || (headerData.documento && headerData.documento.length <= 11) ? '2' : '1';
    const cleanDoc = (headerData.documento || '').replace(/\D/g, '').padStart(14, '0');
    const cleanCei = (headerData.cei || '').replace(/\D/g, '').padStart(12, '0');
    const razao = (headerData.razaoSocial || 'EMPRESA').padEnd(150, ' ').slice(0, 150);
    const repSerial = (headerData.serialRep || '00000000000000000').padStart(17, '0').slice(0, 17);

    let firstDate = dateStr;
    let lastDate = dateStr;
    if (records.length > 0) {
      try {
        const d1 = new Date(records[0].DataHora);
        const d2 = new Date(records[records.length - 1].DataHora);
        firstDate = `${String(d1.getDate()).padStart(2, '0')}${String(d1.getMonth() + 1).padStart(2, '0')}${d1.getFullYear()}`;
        lastDate = `${String(d2.getDate()).padStart(2, '0')}${String(d2.getMonth() + 1).padStart(2, '0')}${d2.getFullYear()}`;
      } catch {}
    }

    const headerLine = `00000000011${tipoDoc}${cleanDoc}${cleanCei}${razao}${repSerial}${firstDate}${lastDate}${dateStr}${timeStr}`;
    lines.push(headerLine);
  }

  // 2. Registros de Batida (Tipo 3)
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const nsrStr = String(r.Nsr || i + 1).padStart(9, '0');
    const dt = new Date(r.DataHora);
    const dStr = `${String(dt.getDate()).padStart(2, '0')}${String(dt.getMonth() + 1).padStart(2, '0')}${dt.getFullYear()}`;
    const tStr = `${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}`;

    if (portaria671 || r.RegistroPortaria671 || r.CPF) {
      const cleanCpf = (r.CPF || '').replace(/\D/g, '').padStart(11, '0');
      const isoDt = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}T${tStr}:00-03:00`;
      const crc = r.CRC || '0000';
      lines.push(`${nsrStr}3${isoDt}${cleanCpf}${crc}`);
    } else {
      const cleanPis = (r.PIS || '').replace(/\D/g, '').padStart(11, '0');
      const crc = r.CRC || '';
      lines.push(`${nsrStr}3${dStr}${tStr}${cleanPis}${crc}`);
    }
  }

  // 3. Rodapé (Tipo 9)
  if (includeHeaderFooter) {
    const totalPunches = String(records.length).padStart(9, '0');
    const footerLine = `999999999000000000${totalPunches}0000000000000000009`;
    lines.push(footerLine);
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate manufacturer-specific offline USB files for employees and employer.
 * Discovered via REA from:
 *   - HenryRepComunicacao (COLAB.TXT / EMPRESA.TXT)
 *   - ControliDRepComunicacao (usuarios.txt / users.txt / users.json / empresa.txt)
 *   - InnerRepPlusNativoComunicacao (InnerRep.txt / Empresa.txt)
 *   - ProveuRepComunicacao (funcionarios.prv / empresa.prv)
 * @param {string} manufacturerFamily - 'henry' | 'controlid' | 'topdata' | 'proveu' | 'generic'
 * @param {object} employer - Employer data from Secullum Cloud
 * @param {Array<object>} employees - Employee list from Secullum Cloud
 * @param {string} targetDir - Destination folder (pendrive root or target directory)
 * @returns {{ ok: boolean, files: Array<{ name: string, path: string, size: number }>, count: number, error?: string }}
 */
function generateManufacturerUsbCharge(manufacturerFamily, employer, employees = [], targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return { ok: false, files: [], count: 0, error: `Diretório de destino inexistente: ${targetDir}` };
  }

  const generated = [];
  const family = (manufacturerFamily || 'generic').toLowerCase();

  const writeAndRecord = (filename, content, encoding = 'ascii') => {
    const fullPath = path.join(targetDir, filename);
    fs.writeFileSync(fullPath, content, { encoding });
    const stat = fs.statSync(fullPath);
    generated.push({ name: filename, path: fullPath, size: stat.size });
  };

  const docTipo = employer.tipoDocumento === 'CPF' || (employer.documento && employer.documento.length <= 11) ? '2' : '1';
  const cleanDoc = (employer.documento || '').replace(/\D/g, '');
  const cleanCei = (employer.cei || '').replace(/\D/g, '');
  const razao = employer.razaoSocial || 'EMPRESA';
  const local = employer.local || '';

  switch (family) {
    case 'controlid': {
      // 1. usuarios.txt (CSV format for iDClass USB import)
      // Header: Nome;PIS;CPF;Matricula;Senha;Cartao
      const userLines = ['Nome;PIS;CPF;Matricula;Senha;Cartao'];
      for (const emp of employees) {
        const p = (emp.Pis || '').replace(/\D/g, '');
        const c = (emp.Cpf || '').replace(/\D/g, '');
        const m = emp.NumeroFolha || emp.Matricula || '';
        const s = emp.Senha || '';
        const rfid = emp.NumeroCartao || '';
        userLines.push(`${emp.Nome};${p};${c};${m};${s};${rfid}`);
      }
      writeAndRecord('usuarios.txt', userLines.join('\r\n') + '\r\n', 'utf-8');
      writeAndRecord('users.txt', userLines.join('\r\n') + '\r\n', 'utf-8');

      // 2. empresa.txt
      const empLine = `RazaoSocial;CNPJ;CEI;Local\r\n${razao};${cleanDoc};${cleanCei};${local}\r\n`;
      writeAndRecord('empresa.txt', empLine, 'utf-8');

      // 3. users.json (for newer Control iD firmware)
      const jsonList = employees.map((emp, idx) => ({
        id: idx + 1,
        name: emp.Nome,
        cpf: (emp.Cpf || '').replace(/\D/g, ''),
        pis: (emp.Pis || '').replace(/\D/g, ''),
        registration: emp.NumeroFolha || emp.Matricula || '',
        password: emp.Senha || '',
      }));
      writeAndRecord('users.json', JSON.stringify(jsonList, null, 2), 'utf-8');
      break;
    }

    case 'henry': {
      // 1. COLAB.TXT (Henry 8x / Prisma / Hexa pendrive carga)
      // Format: {Operacao}\t{PIS/CPF}\t{Nome}\t{VerificaBio}\t{Senha}
      const colabLines = [];
      for (const emp of employees) {
        const idDoc = (emp.Pis || emp.Cpf || '').replace(/\D/g, '');
        const bio = emp.VerificaBiometria ? '1' : '0';
        const senha = emp.Senha || '';
        colabLines.push(`I\t${idDoc}\t${emp.Nome}\t${bio}\t${senha}`);
      }
      writeAndRecord('COLAB.TXT', colabLines.join('\r\n') + '\r\n');
      writeAndRecord('FUNCIONARIOS.TXT', colabLines.join('\r\n') + '\r\n');

      // 2. EMPRESA.TXT (Henry 8x empresa)
      const empLine = `${docTipo}\t${cleanDoc}\t${cleanCei}\t${razao}\t${local}\r\n`;
      writeAndRecord('EMPRESA.TXT', empLine);
      break;
    }

    case 'topdata': {
      // 1. InnerRep.txt (Topdata Inner Rep / Inner Rep Plus)
      // Format: {PIS};{Nome};{Cartao};{VerificaBio};{Senha}
      const innerLines = [];
      for (const emp of employees) {
        const p = (emp.Pis || '').replace(/\D/g, '');
        const rfid = emp.NumeroCartao || '';
        const bio = emp.VerificaBiometria ? '1' : '0';
        const s = emp.Senha || '';
        innerLines.push(`${p};${emp.Nome};${rfid};${bio};${s}`);
      }
      writeAndRecord('InnerRep.txt', innerLines.join('\r\n') + '\r\n');
      writeAndRecord('Funcionarios.txt', innerLines.join('\r\n') + '\r\n');

      // 2. Empresa.txt
      const empLine = `${docTipo};${cleanDoc};${cleanCei};${razao}\r\n`;
      writeAndRecord('Empresa.txt', empLine);
      break;
    }

    case 'proveu': {
      // 1. funcionarios.prv (Proveu Kurumim)
      // Format: {NumeroIdentificador:4};{PIS:11};{Nome:30};{Biometria:SIM/NAO}
      const prvLines = [];
      for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const numId = String(i + 1).padStart(4, '0');
        const p = (emp.Pis || '').replace(/\D/g, '').padStart(11, '0');
        const n = (emp.Nome || '').padEnd(30, ' ').slice(0, 30);
        const bio = emp.VerificaBiometria ? 'SIM' : 'NAO';
        prvLines.push(`${numId};${p};${n};${bio}`);
      }
      writeAndRecord('funcionarios.prv', prvLines.join('\r\n') + '\r\n');

      // 2. empresa.prv
      const empLine = `${docTipo};${cleanDoc};${cleanCei};${razao};${local}\r\n`;
      writeAndRecord('empresa.prv', empLine);
      break;
    }

    default: {
      // Generic / Portaria 671 / 1510
      const genLines = ['PIS;CPF;Nome;Matricula;Cartao;Senha'];
      for (const emp of employees) {
        const p = (emp.Pis || '').replace(/\D/g, '');
        const c = (emp.Cpf || '').replace(/\D/g, '');
        const m = emp.NumeroFolha || emp.Matricula || '';
        const rfid = emp.NumeroCartao || '';
        const s = emp.Senha || '';
        genLines.push(`${p};${c};${emp.Nome};${m};${rfid};${s}`);
      }
      writeAndRecord('CARGA_COLABORADORES.TXT', genLines.join('\r\n') + '\r\n', 'utf-8');
      writeAndRecord('EMPRESA.TXT', `TipoDoc=${docTipo}\r\nDocumento=${cleanDoc}\r\nCEI=${cleanCei}\r\nRazaoSocial=${razao}\r\n`, 'utf-8');
      break;
    }
  }

  return { ok: true, files: generated, count: employees.length };
}

module.exports = {
  detectUsbDrives,
  findAfdFilesInPath,
  parseAfdContent,
  generateAfdFile,
  generateManufacturerUsbCharge,
};
