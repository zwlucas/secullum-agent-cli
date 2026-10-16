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
 * Enrich punch records with employee PIS, Matricula, and default DadosRegistroOffline fields.
 * Discovered via REA from ComunicacaoService.AtualizarListaRegistrosSemPisAsync.
 * @param {Array<object>} records
 * @param {Array<object>} [employees=[]]
 * @returns {Array<object>}
 */
function enrichPunchRecords(records, employees = []) {
  if (!records || !Array.isArray(records)) return [];

  const empByCpf = new Map();
  const empByPis = new Map();
  const empByFolha = new Map();

  for (const emp of employees || []) {
    if (emp.Cpf) {
      const cleanCpf = String(emp.Cpf).replace(/\D/g, '');
      empByCpf.set(cleanCpf, emp);
      empByCpf.set(cleanCpf.replace(/^0+/, ''), emp);
    }
    if (emp.NumeroPis) {
      const cleanPis = String(emp.NumeroPis).replace(/\D/g, '');
      empByPis.set(cleanPis, emp);
      empByPis.set(cleanPis.replace(/^0+/, ''), emp);
    }
    if (emp.NumeroFolha) {
      empByFolha.set(String(emp.NumeroFolha).trim(), emp);
    }
  }

  return records.map((r) => {
    let matchedEmp = null;

    if (r.CPF) {
      const clean = String(r.CPF).replace(/\D/g, '');
      matchedEmp = empByCpf.get(clean) || empByCpf.get(clean.replace(/^0+/, ''));
    }

    if (!matchedEmp && r.PIS) {
      const cleanPis = String(r.PIS).replace(/\D/g, '');
      matchedEmp = empByPis.get(cleanPis) || empByPis.get(cleanPis.replace(/^0+/, ''));
    }

    if (!matchedEmp && r.Matricula) {
      matchedEmp = empByFolha.get(String(r.Matricula).trim());
    }

    const copy = { ...r };

    if (matchedEmp) {
      if (!copy.PIS && matchedEmp.NumeroPis) {
        copy.PIS = String(matchedEmp.NumeroPis).replace(/\D/g, '');
      }
      if (!copy.Matricula && matchedEmp.NumeroFolha) {
        copy.Matricula = String(matchedEmp.NumeroFolha).trim();
      }
      if (!copy.CPF && matchedEmp.Cpf) {
        copy.CPF = String(matchedEmp.Cpf).replace(/\D/g, '');
      }
    }

    if (copy.TipoEvento === undefined) {
      copy.TipoEvento = 3; // 3 = RegistroDePonto (CRITICAL: Secullum Cloud filters out records with TipoEvento != 3)
    }
    if (copy.FusoHorarioMinutos === undefined) {
      copy.FusoHorarioMinutos = -180;
    }
    if (copy.DataHoraAlterada === undefined) {
      copy.DataHoraAlterada = null;
    }
    if (copy.FusoHorarioId === undefined) {
      copy.FusoHorarioId = null;
    }
    if (copy.Sentido === undefined) {
      copy.Sentido = 0;
    }
    if (copy.Tipo === undefined) {
      copy.Tipo = 0;
    }

    return copy;
  });
}

/**
 * Upload collected punch records (AFD / Batidas de Ponto) to Secullum Cloud.
 * Automatically enriches records with employee PIS/Matricula and sets TipoEvento: 3.
 * Discovered via REA from BatidasService.SalvarAsync.
 * @param {Array<object>} records - List of DadosRegistroOffline
 * @param {boolean} [isTemporary=true]
 * @param {object} [options]
 * @returns {Promise<any>}
 */
async function uploadPunchRecords(records, isTemporary = true, options = {}) {
  if (!records || records.length === 0) {
    return { count: 0, status: 'No records to upload' };
  }

  let enriched = records;
  try {
    const employees = await fetchEmployees(options);
    enriched = enrichPunchRecords(records, employees);
  } catch {
    enriched = enrichPunchRecords(records, []);
  }

  return post(`TabelaTemporaria/${Boolean(isTemporary)}`, enriched, options);
}

/**
 * Fetch all employees registered in the company database from Secullum Cloud.
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
async function fetchEmployees(options = {}) {
  return get('Funcionarios', options);
}

/**
 * Fetch employer data (DadosEmpregador) for a specific equipment from Secullum Cloud.
 * Combines header data (ObterDadosCabecalhoAFD) and company profile (Empresas/{id}).
 * Discovered via REA in Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.
 * @param {number|string} equipId
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function fetchEmployer(equipId, options = {}) {
  const equip = await getEquipment(equipId, options);
  let headerData = {};
  try {
    headerData = await getAfdHeader(equipId, options);
  } catch {}

  let empresa = null;
  if (equip.EmpresaId) {
    try {
      empresa = await get(`Empresas/${equip.EmpresaId}`, options);
    } catch {}
  }

  let local = '';
  if (empresa && empresa.Endereco) {
    const parts = [
      empresa.Endereco,
      empresa.Bairro,
      empresa.Uf,
    ].filter(Boolean);
    local = parts.join(' - ');
  } else if (equip.Localizacao) {
    local = equip.Localizacao;
  }

  const rawDoc = headerData.Documento || empresa?.Documento || '';
  const cleanDoc = String(rawDoc).replace(/\D/g, '');
  const tipoDoc = headerData.TipoDeDocumento !== undefined
    ? headerData.TipoDeDocumento
    : (empresa?.TipoDocumento !== undefined ? empresa.TipoDocumento : (cleanDoc.length === 11 ? 1 : 0));

  return {
    EquipamentoId: Number(equipId),
    RazaoSocial: headerData.NomeEmpresa || empresa?.Nome || equip.Descricao || '',
    Local: local || 'Local',
    TipoDeDocumento: tipoDoc,
    Documento: cleanDoc,
    Cei: (headerData.CEI || empresa?.CEI || '0').replace(/\D/g, '') || '0',
    NaoValidar: false,
  };
}

/**
 * Upload enrolled biometric templates (ReceberDigitais) to Secullum Cloud via SignalR Hub.
 * Discovered via REA from Secullum.PontoWeb.ServicoComunicacao.Services.ComunicacaoService.ReceberDigitais:
 *   1. Hub 'Comunicacao', Method 'InformarAtualizarDigitais' ([biometrics, tipoBiometria, equipId])
 *   2. Hub 'Comunicacao', Method 'InformarDigitaisRecebidas' in chunks of 25 ([chunk, equipId])
 *   3. Hub 'Comunicacao', Method 'InformarTerminoComunicacao' ([equipId, ''])
 * @param {number|string} equipId
 * @param {Array<object>} biometrics - List of DadosPessoaBiometria
 * @param {number} [tipoBiometria=0] - 0: Suprema (Henry), 16: Innovatrics (Control iD)
 * @param {object} [existingGateway=null] - Active RealTimeGateway instance if already connected
 * @returns {Promise<{ ok: boolean, count: number, error?: string }>}
 */
async function uploadBiometrics(equipId, biometrics = [], tipoBiometria = 0, existingGateway = null) {
  const { RealTimeGateway } = require('./realtime');
  const numEquipId = Number(equipId);

  let gateway = existingGateway;
  let ownsGateway = false;

  try {
    if (!gateway || !gateway.isAuthenticated) {
      ownsGateway = true;
      gateway = new RealTimeGateway({
        equipments: [numEquipId],
        autoReconnect: false,
      });
      await gateway.connect();
      // Brief wait to ensure registration message flushed
      await new Promise((r) => setTimeout(r, 500));
    }

    // 1. Inform biometrics update and type
    gateway.sendHubMethod('Comunicacao', 'InformarAtualizarDigitais', [
      biometrics,
      Number(tipoBiometria),
      numEquipId,
    ]);

    // 2. Transmit biometrics in chunks of 25
    const chunkSize = 25;
    for (let i = 0; i < biometrics.length; i += chunkSize) {
      const chunk = biometrics.slice(i, i + chunkSize);
      gateway.sendHubMethod('Comunicacao', 'InformarDigitaisRecebidas', [
        chunk,
        numEquipId,
      ]);
    }

    // 3. Notify completion of biometrics receiving (TipoTarefa.ReceberDigitais = 28)
    if (typeof gateway.informarTerminoComunicacao === 'function') {
      gateway.informarTerminoComunicacao(numEquipId, 28, '');
    } else {
      gateway.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [
        numEquipId,
        28,
        '',
      ]);
    }

    // Give websocket a moment to flush outbound frames before disconnecting if transient
    if (ownsGateway) {
      await new Promise((r) => setTimeout(r, 1000));
      gateway.disconnect();
    }

    return { ok: true, count: biometrics.length };
  } catch (err) {
    if (ownsGateway && gateway) {
      try { gateway.disconnect(); } catch {}
    }
    return { ok: false, count: 0, error: err.message };
  }
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
  enrichPunchRecords,
  fetchEmployees,
  fetchEmployer,
  uploadBiometrics,
};

