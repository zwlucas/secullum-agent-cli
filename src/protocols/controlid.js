/**
 * protocols/controlid.js - Control iD (iDClass / iDAccess / iDFace / iDFlex) Protocol.
 * Reverse-engineered via REA from Secullum.Comunicacao.ControliDRepComunicacao
 * and Secullum.Comunicacao.ControliDAcessoComunicacao.
 *
 * Architecture:
 *   - FastCGI HTTP/JSON REST API on device HTTP port (default: 80)
 *   - Endpoints:
 *       POST /login.fcgi
 *       POST /system_information.fcgi?session={token}
 *       POST /set_system_time.fcgi?session={token}
 *       POST /load_objects.fcgi?session={token}
 *       POST /logout.fcgi?session={token}
 * Zero external npm dependencies.
 */

'use strict';

/**
 * Execute an HTTP JSON request against a Control iD terminal.
 * @param {string} ip
 * @param {number} port
 * @param {string} endpoint
 * @param {object} [body={}]
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<any>}
 */
async function controlIdRequest(ip, port, endpoint, body = {}, timeoutMs = 3000) {
  const url = `http://${ip}:${port}/${endpoint.replace(/^\//, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Control iD HTTP ${res.status}: ${res.statusText}`);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Authenticate session on a Control iD terminal.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, session?: string, error?: string }>}
 */
async function loginControlId(ip, port = 80, login = 'admin', password = 'admin') {
  try {
    const res = await controlIdRequest(ip, port, 'login.fcgi', { login, password });
    if (res && res.session) {
      return { ok: true, session: res.session };
    }
    return { ok: false, error: 'Invalid response from device' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Logout session from a Control iD terminal.
 * @param {string} ip
 * @param {number} port
 * @param {string} session
 */
async function logoutControlId(ip, port, session) {
  if (!session) return;
  try {
    await controlIdRequest(ip, port, `logout.fcgi?session=${session}`);
  } catch {}
}

/**
 * Get device system information (serial, version, model).
 * @param {string} ip
 * @param {number} [port=80]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, info?: object, latencyMs: number, error?: string }>}
 */
async function getControlIdSystemInfo(ip, port = 80, login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const info = await controlIdRequest(ip, port, `system_information.fcgi?session=${auth.session}`);
    await logoutControlId(ip, port, auth.session);
    return { ok: true, info, latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Synchronize date and time on a Control iD terminal.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {Date} [date=new Date()]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function syncControlIdDateTime(ip, port = 80, date = new Date(), login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const payload = {
      day: date.getDate(),
      month: date.getMonth() + 1,
      year: date.getFullYear(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };

    await controlIdRequest(ip, port, `set_system_time.fcgi?session=${auth.session}`, payload);
    await logoutControlId(ip, port, auth.session);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Fetch access logs / AFD entries from a Control iD terminal.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {number} [limit=100]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, logs?: any[], latencyMs: number, error?: string }>}
 */
async function getControlIdLogs(ip, port = 80, limit = 100, login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const res = await controlIdRequest(ip, port, `load_objects.fcgi?session=${auth.session}`, {
      object: 'access_logs',
      limit,
    });
    await logoutControlId(ip, port, auth.session);
    return { ok: true, logs: res.access_logs || [], latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Send employee list to a Control iD terminal.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {Array<object>} employees
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, count: number, latencyMs: number, error?: string }>}
 */
async function sendControlIdEmployees(ip, port = 80, employees = [], login = 'admin', password = 'admin') {
  if (!employees || employees.length === 0) return { ok: true, count: 0, latencyMs: 0 };
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, count: 0, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const users = employees.map((emp) => ({
      name: (emp.Nome || '').slice(0, 50),
      registration: String(emp.NumeroFolha || emp.NumeroIdentificador || emp.Id),
      cpf: (emp.Cpf || '').replace(/\D/g, ''),
    }));

    await controlIdRequest(ip, port, `set_objects.fcgi?session=${auth.session}`, {
      object: 'users',
      values: users,
    });
    await logoutControlId(ip, port, auth.session);
    return { ok: true, count: users.length, latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, count: 0, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Send employer data to a Control iD terminal (/edit_company.fcgi).
 * Discovered via REA in Secullum.Comunicacao.Classes.Equipamentos.ControliD.ControliDRepComunicacaoNativa.EnviarEmpregador.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {object} employer - DadosEmpregador
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function sendControlIdEmployer(ip, port = 80, employer, login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const docDigits = String(employer.Documento || '').replace(/\D/g, '');
    const ceiDigits = String(employer.Cei || '0').replace(/\D/g, '') || '0';
    // tipo_doc: 1 = CNPJ, 2 = CPF (Secullum TipoDeDocumento enum: 0 = CNPJ, 1 = CPF -> + 1)
    const tipoDoc = Number(employer.TipoDeDocumento) === 1 || docDigits.length === 11 ? 2 : 1;

    const body = {
      company: {
        tipo_doc: tipoDoc,
        cpf_cnpj: Number(docDigits),
        cei: Number(ceiDigits),
        cpf: 0,
        name: (employer.RazaoSocial || employer.Nome || '').slice(0, 150),
        address: (employer.Local || employer.Endereco || 'Local').slice(0, 150),
      },
    };

    await controlIdRequest(ip, port, `edit_company.fcgi?session=${auth.session}`, body);
    await logoutControlId(ip, port, auth.session);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Get employer data from a Control iD terminal (/load_company.fcgi).
 * Discovered via REA in Secullum.Comunicacao.Classes.Equipamentos.ControliD.ControliDRepComunicacaoNativa.ReceberEmpregador.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, employer?: object, latencyMs: number, error?: string }>}
 */
async function getControlIdEmployer(ip, port = 80, login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const res = await controlIdRequest(ip, port, `load_company.fcgi?session=${auth.session}`, {});
    await logoutControlId(ip, port, auth.session);

    if (res && res.company) {
      const c = res.company;
      const employer = {
        TipoDeDocumento: Number(c.tipo_doc) === 2 ? 1 : 0, // 0 = CNPJ, 1 = CPF
        Documento: String(c.cpf_cnpj || ''),
        Cei: String(c.cei || '').replace(/^0+/, ''),
        RazaoSocial: c.name || '',
        Local: c.address || '',
      };
      return { ok: true, employer, latencyMs: Date.now() - start };
    }
    return { ok: false, latencyMs: Date.now() - start, error: 'Empty employer response' };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

module.exports = {
  controlIdRequest,
  loginControlId,
  logoutControlId,
  getControlIdSystemInfo,
  syncControlIdDateTime,
  getControlIdLogs,
  sendControlIdEmployees,
  sendControlIdEmployer,
  getControlIdEmployer,
};

