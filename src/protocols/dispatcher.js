/**
 * protocols/dispatcher.js - Central Manufacturer Protocol Dispatcher.
 * Routes device-specific commands (time sync, status check, log collection)
 * to the appropriate manufacturer protocol driver based on equipment type ID.
 * Zero external npm dependencies.
 */

'use strict';

const henry = require('./henry');
const controlid = require('./controlid');
const topdata = require('./topdata');

const HENRY_TYPES = new Set([0, 1, 2, 3, 4, 13, 21, 22, 23, 37, 40, 42]);
const CONTROLID_TYPES = new Set([5, 6, 7, 35, 36, 38]);
const TOPDATA_TYPES = new Set([8, 9, 10, 41, 45, 46]);

/**
 * Determine the manufacturer family for a given equipment type ID.
 * @param {number} typeId
 * @returns {'henry' | 'controlid' | 'topdata' | 'generic'}
 */
function getManufacturerFamily(typeId) {
  if (HENRY_TYPES.has(Number(typeId))) return 'henry';
  if (CONTROLID_TYPES.has(Number(typeId))) return 'controlid';
  if (TOPDATA_TYPES.has(Number(typeId))) return 'topdata';
  return 'generic';
}

/**
 * Synchronize date and time with an equipment using its manufacturer-specific protocol.
 * @param {object} eq - Normalized equipment object
 * @param {Date} [date=new Date()]
 * @returns {Promise<{ ok: boolean, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function syncEquipmentDateTime(eq, date = new Date()) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;

  if (!ip) {
    return { ok: false, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.syncHenryDateTime(ip, port, date);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.syncControlIdDateTime(ip, port, date);
      return { ...res, manufacturer: 'Control iD' };
    }
    case 'topdata': {
      const res = await topdata.syncTopdataDateTime(ip, port, date);
      return { ...res, manufacturer: 'Topdata' };
    }
    default: {
      return { ok: false, manufacturer: 'Generic', latencyMs: 0, error: `Protocol driver for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Query status / telemetry from an equipment using its manufacturer-specific protocol.
 * @param {object} eq - Normalized equipment object
 * @returns {Promise<{ ok: boolean, manufacturer: string, data?: any, latencyMs: number, error?: string }>}
 */
async function queryEquipmentStatus(eq) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.queryHenryStatus(ip, port, password);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.getControlIdPaperRollStatus(ip, port, 'admin', password || 'admin');
      return { ...res, statusBobina: res.status, data: res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, manufacturer: 'Generic', latencyMs: 0, error: `Status telemetry for type #${eq.tipoId} not supported` };
    }
  }
}

/**
 * Query paper roll sensor status (EstadoBobina) from equipment using its manufacturer-specific protocol.
 * Discovered via REA from Secullum.Comunicacao.IEquipamentoRep.EstadoBobina.
 * @param {object} eq - Normalized equipment object
 * @returns {Promise<{ ok: boolean, status: string, paperOk: boolean, lowPaper: boolean, description: string, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function queryEquipmentPaperRoll(eq) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, status: 'Desconhecido', paperOk: false, lowPaper: false, description: 'Equipamento sem IP configurado', manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.getHenryPaperRollStatus(ip, port, password);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.getControlIdPaperRollStatus(ip, port, 'admin', password || 'admin');
      return { ...res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, status: 'Normal', paperOk: true, lowPaper: false, description: `Sensor de bobina não suportado para tipo #${eq.tipoId}`, manufacturer: 'Generic', latencyMs: 0 };
    }
  }
}

/**
 * Collect punch records (AFD / Batidas) from equipment using its manufacturer-specific protocol.
 * @param {object} eq - Normalized equipment object
 * @param {number} [nsr=0] - Starting NSR
 * @param {number} [count=100] - Maximum records to fetch per batch
 * @returns {Promise<{ ok: boolean, records: Array<object>, lastNsr: number, rawCount: number, manufacturer: string, error?: string }>}
 */
async function collectEquipmentRecords(eq, nsr = 0, count = 100) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';
  const startNsr = nsr !== undefined && nsr !== null ? Number(nsr) : (eq.ultimoNsr || 0);

  if (!ip) {
    return { ok: false, records: [], lastNsr: startNsr, rawCount: 0, manufacturer: family, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.collectHenryRecords(ip, port, startNsr, count, password, eq.id);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.getControlIdLogs(ip, port, count, 'admin', password || 'admin');
      if (!res.ok) {
        return { ok: false, records: [], lastNsr: startNsr, rawCount: 0, manufacturer: 'Control iD', error: res.error };
      }
      const records = (res.logs || []).map((l) => ({
        Nsr: l.id || 0,
        DataHora: l.time ? new Date(l.time * 1000).toISOString().slice(0, 19) : new Date().toISOString().slice(0, 19),
        CPF: null,
        PIS: String(l.user_id || ''),
        Matricula: null,
        EquipamentoId: eq.id,
        RegistroPortaria671: false,
        Sentido: 0,
        Tipo: 0,
        CRC: null,
      }));
      const maxNsr = records.reduce((max, r) => (r.Nsr > max ? r.Nsr : max), startNsr);
      return { ok: true, records, lastNsr: maxNsr, rawCount: records.length, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, records: [], lastNsr: startNsr, rawCount: 0, manufacturer: 'Generic', error: `AFD collection for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Send employee list to equipment using its manufacturer-specific protocol.
 * @param {object} eq - Normalized equipment object
 * @param {Array<object>} employees - List of employees from Secullum Cloud
 * @returns {Promise<{ ok: boolean, count: number, manufacturer: string, error?: string }>}
 */
async function sendEquipmentEmployees(eq, employees = []) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, count: 0, manufacturer: family, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.sendHenryEmployees(ip, port, employees, password);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.sendControlIdEmployees(ip, port, employees, 'admin', password || 'admin');
      return { ...res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, count: 0, manufacturer: 'Generic', error: `Employee sync for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Send employer data to equipment using its manufacturer-specific protocol.
 * Discovered via REA from Secullum.Comunicacao.IEquipamentoRep.EnviarEmpregador.
 * @param {object} eq - Normalized equipment object
 * @param {object} employer - DadosEmpregador
 * @returns {Promise<{ ok: boolean, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function sendEquipmentEmployer(eq, employer) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.sendHenryEmployer(ip, port, employer, password);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.sendControlIdEmployer(ip, port, employer, 'admin', password || 'admin');
      return { ...res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, manufacturer: 'Generic', latencyMs: 0, error: `Employer sync for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Receive employer data from equipment using its manufacturer-specific protocol.
 * Discovered via REA from Secullum.Comunicacao.IEquipamentoRep.ReceberEmpregador.
 * @param {object} eq - Normalized equipment object
 * @returns {Promise<{ ok: boolean, employer?: object, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function receiveEquipmentEmployer(eq) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.receiveHenryEmployer(ip, port, password);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.getControlIdEmployer(ip, port, 'admin', password || 'admin');
      return { ...res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, manufacturer: 'Generic', latencyMs: 0, error: `Employer read for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Receive registered biometric fingerprint templates from equipment using its manufacturer-specific protocol.
 * Discovered via REA from Secullum.Comunicacao.IEquipamentoBiometrico.ReceberDigitais.
 * @param {object} eq - Normalized equipment object
 * @param {Array<object>} [employees=[]] - Cloud employee records
 * @param {function} [onProgress] - Optional progress callback
 * @returns {Promise<{ ok: boolean, biometrics: Array<object>, count: number, tipoBiometria: number, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function receiveEquipmentBiometrics(eq, employees = [], onProgress = null) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, biometrics: [], count: 0, tipoBiometria: 0, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.receiveHenryBiometrics(ip, port, employees, password, onProgress);
      return { ...res, tipoBiometria: 0, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.getControlIdBiometrics(ip, port, employees, 'admin', password || 'admin', onProgress);
      return { ...res, tipoBiometria: 16, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, biometrics: [], count: 0, tipoBiometria: 0, manufacturer: 'Generic', latencyMs: 0, error: `Biometrics extraction for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Delete specified employees from equipment using its manufacturer-specific protocol.
 * Discovered via REA from Secullum.Comunicacao.IEquipamento.ApagarPessoas.
 * @param {object} eq - Normalized equipment object
 * @param {Array<object|string>} [employees=[]]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, count: number, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function deleteEquipmentEmployees(eq, employees = [], onProgress = null) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, count: 0, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.deleteHenryEmployees(ip, port, employees, password, onProgress);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.deleteControlIdEmployees(ip, port, employees, 'admin', password || 'admin', onProgress);
      return { ...res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, count: 0, manufacturer: 'Generic', latencyMs: 0, error: `Employee deletion for type #${eq.tipoId} not yet implemented` };
    }
  }
}

/**
 * Clear all employees from equipment memory using its manufacturer-specific protocol.
 * @param {object} eq - Normalized equipment object
 * @returns {Promise<{ ok: boolean, manufacturer: string, latencyMs: number, error?: string }>}
 */
async function clearEquipmentEmployees(eq) {
  const family = getManufacturerFamily(eq.tipoId);
  const ip = eq.ip;
  const port = eq.porta;
  const password = eq.senha || '';

  if (!ip) {
    return { ok: false, manufacturer: family, latencyMs: 0, error: 'Equipment has no IP address configured' };
  }

  switch (family) {
    case 'henry': {
      const res = await henry.clearHenryEmployees(ip, port, password);
      return { ...res, manufacturer: 'Henry' };
    }
    case 'controlid': {
      const res = await controlid.clearControlIdEmployees(ip, port, 'admin', password || 'admin');
      return { ...res, manufacturer: 'Control iD' };
    }
    default: {
      return { ok: false, manufacturer: 'Generic', latencyMs: 0, error: `Employee wipe for type #${eq.tipoId} not yet implemented` };
    }
  }
}

module.exports = {
  getManufacturerFamily,
  syncEquipmentDateTime,
  queryEquipmentStatus,
  collectEquipmentRecords,
  sendEquipmentEmployees,
  deleteEquipmentEmployees,
  clearEquipmentEmployees,
  sendEquipmentEmployer,
  receiveEquipmentEmployer,
  receiveEquipmentBiometrics,
  queryEquipmentPaperRoll,
};

