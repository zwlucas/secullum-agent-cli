/**
 * cloud/pontoweb.js - Direct REST client for Secullum PontoWeb Cloud API.
 * Endpoints discovered via REA from Secullum.PontoWeb.ServicoComunicacao.exe:
 *   - GET  https://pontoweb.secullum.com.br/Equipamentos/v2
 *   - GET  https://pontoweb.secullum.com.br/Equipamentos/{id}
 *   - GET  https://pontoweb.secullum.com.br/Equipamentos/ObterDataHoraServidor/{fusoHorarioId}
 *   - GET  https://pontoweb.secullum.com.br/EquipamentoRecebimentoRegistro/ObterDadosCabecalhoAFD/{equipId}
 *   - GET  https://pontoweb.secullum.com.br/Versao
 *   - POST https://pontoweb.secullum.com.br/TabelaTemporaria/{tipo}
 *
 * Headers required by Secullum Cloud:
 *   - Authorization: Bearer <token>
 *   - secullumbancoselecionado: <bancoId>
 *   - secullumversaoagente: 1.54.0.0
 * Zero external npm dependencies.
 */

'use strict';

const { getValidAccessToken } = require('./auth');
const { loadSession, saveSession } = require('./session');

const PONTOWEB_BASE_URL = 'https://pontoweb.secullum.com.br';
const AGENT_VERSION = '1.54.0.0';

/**
 * Build standard headers for PontoWeb API calls.
 * @param {string} token
 * @param {string} bancoId
 * @returns {Record<string, string>}
 */
function buildHeaders(token, bancoId) {
  const headers = {
    'Accept': 'application/json',
    'secullumversaoagente': AGENT_VERSION,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (bancoId) {
    headers['secullumbancoselecionado'] = bancoId;
  }

  return headers;
}

/**
 * Execute an authenticated GET request against PontoWeb.
 * @param {string} endpoint - Path relative to base URL (e.g. '/Equipamentos/v2')
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {string} [options.bancoId]
 * @returns {Promise<any>}
 */
async function get(endpoint, options = {}) {
  const session = loadSession() || {};
  const token = options.token || (await getValidAccessToken());
  const bancoId = options.bancoId || session.bancoSelecionado?.Identificador || session.bancoId;

  if (!bancoId && !endpoint.includes('Versao')) {
    throw new Error('No database selected. Run: secullum-agent-cli databases');
  }

  const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = `${PONTOWEB_BASE_URL}/${cleanPath}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(token, bancoId),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`PontoWeb API error (${res.status}): ${errorText || res.statusText}`);
  }

  return res.json();
}

/**
 * Execute an authenticated POST request against PontoWeb.
 * @param {string} endpoint
 * @param {any} body
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function post(endpoint, body, options = {}) {
  const session = loadSession() || {};
  const token = options.token || (await getValidAccessToken());
  const bancoId = options.bancoId || session.bancoSelecionado?.Identificador || session.bancoId;

  const cleanPath = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = `${PONTOWEB_BASE_URL}/${cleanPath}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...buildHeaders(token, bancoId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`PontoWeb API error (${res.status}): ${errorText || res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

/**
 * List all equipment registered in the selected database directly from PontoWeb cloud.
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
async function listEquipments(options = {}) {
  return get('Equipamentos/v2', options);
}

/**
 * Get details for a specific equipment by ID.
 * @param {number|string} id
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function getEquipment(id, options = {}) {
  return get(`Equipamentos/${id}`, options);
}

/**
 * Get current server date and time for a given time zone ID.
 * @param {number} [fusoHorarioId=22] - 22 is Brasilia timezone (-03:00)
 * @param {object} [options]
 * @returns {Promise<{ data: string }>}
 */
async function getServerTime(fusoHorarioId = 22, options = {}) {
  return get(`Equipamentos/ObterDataHoraServidor/${fusoHorarioId}`, options);
}

/**
 * Get AFD header data for an equipment.
 * @param {number|string} equipId
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function getAfdHeader(equipId, options = {}) {
  return get(`EquipamentoRecebimentoRegistro/ObterDadosCabecalhoAFD/${equipId}`, options);
}

/**
 * Get current Secullum PontoWeb API version.
 * @returns {Promise<object>}
 */
async function getCloudVersion() {
  return get('Versao', {});
}

/**
 * Upload collected punch records (AFD / Batidas de Ponto) to Secullum Cloud.
 * Discovered via REA from BatidasService.SalvarAsync.
 * @param {Array<object>} records - List of DadosRegistroOffline
 * @param {boolean} [isTemporary=false]
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function uploadPunchRecords(records, isTemporary = false, options = {}) {
  if (!records || records.length === 0) {
    return { count: 0, status: 'No records to upload' };
  }
  return post(`TabelaTemporaria/${Boolean(isTemporary)}`, records, options);
}

/**
 * Fetch all employees registered in the company database from Secullum Cloud.
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
async function fetchEmployees(options = {}) {
  return get('Funcionarios', options);
}

module.exports = {
  PONTOWEB_BASE_URL,
  AGENT_VERSION,
  get,
  post,
  listEquipments,
  getEquipment,
  getServerTime,
  getAfdHeader,
  getCloudVersion,
  uploadPunchRecords,
  fetchEmployees,
};

