/**
 * equipment.js - Equipment type ID → human-readable name mapping.
 */

'use strict';

/** @type {Record<number, string>} */
const EQUIPMENT_TYPES = {
  0:  'Henry - Primme Acesso / Argos / Primme SF',
  1:  'Henry - Rep Prisma',
  2:  'Henry - Primme Ponto',
  3:  'Henry - Rep Prisma SF',
  4:  'Henry - Rep Hexa',
  5:  'Control iD - Rep iDX',
  6:  'Control iD - Rep iDClass',
  7:  'Control iD - iDAccess',
  8:  'Topdata - Inner Acesso',
  9:  'Topdata - Inner Rep',
  10: 'Topdata - Inner Rep Plus',
  11: 'Proveu - Kurumim 373 II',
  12: 'RW - Rep iPointLine / Blue',
  13: 'Henry - Primme Ponto Super Fácil',
  14: 'Proveu - Kurumim Rep 3',
  15: 'Madis Rodbel - MD Rep',
  16: 'Madis Rodbel - MD Rep Evo',
  17: 'Madis Rodbel - Rep 0705',
  18: 'Dimep - PrintPoint II',
  19: 'Dimep - PrintPoint III',
  20: 'Dimep - MiniPrint',
  21: 'Henry - Rep Hexa Advanced',
  22: 'Henry - Rep Prisma Super Fácil Advanced',
  23: 'Henry - Rep Ponto E',
  24: 'Trix - XRep-520',
  25: 'ZPM - Rep R100 / R130 / R200 / R300 / R310 / R410',
  26: 'ZPM - Rep R110 / R150 / R160 / R210 / R330 / R430',
  27: 'Secullum - Rep Genérico',
  28: 'Secullum - Checkin',
  29: 'Dimep - Smart Print',
  30: 'Dimep - Smart Point',
  31: 'Madis Rodbel - MD Rep Evo II',
  32: 'Madis Rodbel - Rep 0706',
  33: 'ZK - SpeedFace',
  34: 'Proveu - Kurumim Rep 2',
  35: 'Control iD - iDFlex',
  36: 'Control iD - iDFace / iDFace Max',
  37: 'Henry - Rep Prisma Super Fácil Advanced 671',
  38: 'Control iD - Rep iDClass 671',
  40: 'Henry - Rep Hexa Advanced 671',
  41: 'Topdata - Inner Ponto 4',
  42: 'Henry - Primme Ponto Super Fácil 671',
  43: 'RW - Blue 671',
  45: 'Topdata - Inner Rep Plus v5',
  46: 'Topdata - Inner 373',
  47: 'Hikvision - Terminal de Reconhecimento Facial',
  48: 'Intelbras - Linha Bio-T',
  49: 'Dixi - IRep I3 Facial',
  51: 'Dixi - Rep Sindnox 671',
  52: 'Secullum - Ponto Virtual',
  55: 'Evo - Rep C',
  56: 'Evo - Rep A',
  57: 'MD Rep Evo II 671',
};

/**
 * Get the human-readable name for an equipment type ID.
 * @param {number} typeId
 * @returns {string}
 */
function getEquipmentTypeName(typeId) {
  return EQUIPMENT_TYPES[typeId] ?? `Desconhecido (${typeId})`;
}

/**
 * Extract TCP port from equipment object or Configuracao string.
 * Discovered via REA from HenryRepConfiguracao.ConverterConfiguracao:
 * Configuration fields are \ separated, index 10 is PortaTcp (default 3000).
 * @param {object} eq
 * @returns {number}
 */

function extractEquipmentPort(eq) {
  if (eq.Porta || eq.porta) return Number(eq.Porta || eq.porta);

  const tipoId = Number(eq.MarcaModelo ?? eq.marcaModelo ?? eq.TipoEquipamento ?? eq.tipoEquipamento ?? eq.Tipo ?? eq.tipo ?? 0);
  const isTopdata = [8, 9, 10, 41, 45, 46].includes(tipoId);

  if (eq.Configuracao) {
    const parts = eq.Configuracao.split('\\');
    // Topdata NATIVO format: index 4 is PortaDoInner
    if (parts[0] === 'NATIVO' && parts.length > 4 && parts[4] && !isNaN(Number(parts[4]))) {
      const p = Number(parts[4]);
      if (p > 0 && p <= 65535) return p;
    }
    // Topdata legacy format: index 2 is Porta
    if (isTopdata && parts.length > 2 && parts[2] && !isNaN(Number(parts[2]))) {
      const p = Number(parts[2]);
      if (p > 0 && p <= 65535) return p;
    }
    // HenryRepConfiguracao index 10 is PortaTcp
    if (parts.length > 10 && parts[10] && !isNaN(Number(parts[10]))) {
      const p = Number(parts[10]);
      if (p > 0 && p <= 65535) return p;
    }
    // Search tokens for valid TCP port
    for (const p of parts) {
      const n = Number(p);
      if (n >= 80 && n <= 65535 && p.length >= 2 && p.length <= 5 && !p.includes('.')) {
        return n;
      }
    }
  }

  return isTopdata ? 3570 : 3000;
}

/**
 * Normalize raw Secullum cloud equipment JSON into standard fields.
 * Replicates Secullum.PontoWeb.ServicoComunicacao.Services.EquipamentosService.PreencherDadosEquipamento
 * @param {object} raw
 * @param {number[]} [addedIds=[]]
 * @returns {object}
 */
function normalizeEquipment(raw, addedIds = []) {
  const id = Number(raw.Id ?? raw.id);
  const descricao = raw.Descricao ?? raw.descricao ?? raw.Nome ?? `Equipamento #${id}`;
  const tipoId = raw.MarcaModelo ?? raw.marcaModelo ?? raw.TipoEquipamento ?? raw.tipoEquipamento ?? raw.Tipo ?? raw.tipo ?? 0;
  const tipo = getEquipmentTypeName(tipoId);
  const comunicacao = Number(raw.Comunicacao ?? raw.comunicacao ?? raw.TipoDeComunicacao ?? 1);
  const ip = (comunicacao === 3) ? '' : (raw.EnderecoIP ?? raw.enderecoIP ?? raw.Ip ?? raw.ip ?? '');
  const porta = extractEquipmentPort(raw);
  const adicionado = addedIds.includes(Number(id));

  // Extract manufacturer configuration tokens (Henry, Control iD, Topdata, etc.)
  let senha = '';
  let ultimoNsr = 0;
  let numeroSerial = '';
  let usuario = '';
  let senhaUsuario = '';
  let chaveComunicacao = '';
  let cpfResponsavel = '';
  let tipoBiometria = null;

  if (raw.Configuracao) {
    const parts = raw.Configuracao.split('\\');
    const isTopdata = [8, 9, 10, 41, 45, 46].includes(Number(tipoId));

    if (isTopdata) {
      if (parts[0] === 'NATIVO') {
        numeroSerial = parts[1] || '';
        if (parts[2] && !isNaN(Number(parts[2]))) ultimoNsr = Number(parts[2]);
        chaveComunicacao = parts[7] || '';
        cpfResponsavel = parts[8] || '';
        if (parts.length > 17 && !isNaN(Number(parts[17]))) tipoBiometria = Number(parts[17]);
      } else {
        numeroSerial = parts[0] || '';
        chaveComunicacao = parts[4] || '';
        cpfResponsavel = parts[17] || '';
        if (parts.length > 18 && !isNaN(Number(parts[18]))) ultimoNsr = Number(parts[18]);
        if (parts.length > 25 && !isNaN(Number(parts[25]))) tipoBiometria = Number(parts[25]);
      }
      senha = chaveComunicacao;
    } else if ([5, 6, 7, 35, 36, 38].includes(Number(tipoId))) {
      // Control iD: index 0 is Serial, index 1 is Senha, index 2 is UltimoNsr
      if (parts.length > 0) numeroSerial = parts[0] || '';
      if (parts.length > 1) senha = parts[1] || '';
      if (parts.length > 2 && !isNaN(Number(parts[2]))) ultimoNsr = Number(parts[2]);
      if (parts.length > 11) usuario = parts[11] || '';
      if (parts.length > 12) senhaUsuario = parts[12] || '';
    } else {
      if (parts.length > 0) numeroSerial = parts[0] || '';
      if (parts.length > 1) senha = parts[1] || '';
      if (parts.length > 6 && !isNaN(Number(parts[6]))) ultimoNsr = Number(parts[6]);
      if (parts.length > 21) usuario = parts[21] || '';
      if (parts.length > 22) senhaUsuario = parts[22] || '';
    }
  }

  return {
    id,
    descricao,
    nome: descricao,
    tipoId,
    tipo,
    comunicacao,
    ip,
    porta,
    senha,
    usuario,
    senhaUsuario,
    chaveComunicacao,
    cpfResponsavel,
    tipoBiometria,
    ultimoNsr,
    numeroSerial,
    configuracao: raw.Configuracao || '',
    adicionado,
    nomeComputador: raw.NomeComputador || '',
    raw,
  };
}

/**
 * Update the last collected NSR inside an equipment's Configuracao string.
 * Discovered via REA from HenryRepConfiguracao, ControliDRepConfiguracao, and InnerRepConfiguracao.
 * @param {string} configStr - Raw \ delimited configuration string
 * @param {number|string} tipoId - Equipment model type ID
 * @param {number|string} newNsr - New last collected NSR
 * @returns {string} - Updated configuration string
 */
function updateEquipmentConfigNsr(configStr, tipoId, newNsr) {
  if (!configStr || typeof configStr !== 'string') return configStr || '';
  const parts = configStr.split('\\');
  const tid = Number(tipoId);
  const nsrStr = String(newNsr);

  if ([8, 9, 10, 41, 45, 46].includes(tid)) {
    // Topdata Inner Rep
    if (parts[0] === 'NATIVO') {
      if (parts.length > 2) parts[2] = nsrStr;
    } else {
      if (parts.length > 18) parts[18] = nsrStr;
    }
  } else if ([5, 6, 7, 35, 36, 38].includes(tid)) {
    // Control iD Rep
    if (parts.length > 2) parts[2] = nsrStr;
  } else {
    // Henry (Prisma, Hexa, Primme) and other standard models (index 6 is UltimoNSRColetado)
    if (parts.length > 6) {
      parts[6] = nsrStr;
    }
  }

  return parts.join('\\');
}

module.exports = {
  EQUIPMENT_TYPES,
  getEquipmentTypeName,
  extractEquipmentPort,
  normalizeEquipment,
  updateEquipmentConfigNsr,
};

