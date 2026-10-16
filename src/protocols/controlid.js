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

/**
 * Receive registered biometric fingerprint templates from a Control iD terminal.
 * Discovered via REA from Secullum.Comunicacao.ControliDRepComunicacaoNativa.ReceberDigitais.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {Array<object>} [employees=[]] - Cloud employee records for ID mapping
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, biometrics: Array<object>, count: number, latencyMs: number, error?: string }>}
 */
async function getControlIdBiometrics(ip, port = 80, employees = [], login = 'admin', password = 'admin', onProgress = null) {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, biometrics: [], count: 0, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    // 1. Fetch templates
    const tmplRes = await controlIdRequest(ip, port, `load_objects.fcgi?session=${auth.session}`, {
      object: 'templates',
    });
    const templates = tmplRes.templates || [];

    // 2. Fetch users to map user_id -> registration/cpf -> employee
    let users = [];
    try {
      const userRes = await controlIdRequest(ip, port, `load_objects.fcgi?session=${auth.session}`, {
        object: 'users',
      });
      users = userRes.users || [];
    } catch {}

    await logoutControlId(ip, port, auth.session);

    // Map user_id to user
    const userMap = new Map();
    for (const u of users) {
      userMap.set(u.id, u);
    }

    // Map registration/cpf to cloud employee
    const empByFolha = new Map();
    const empByCpf = new Map();
    const empById = new Map();
    for (const emp of employees) {
      if (emp.NumeroFolha) empByFolha.set(String(emp.NumeroFolha).replace(/^0+/, ''), emp);
      if (emp.NumeroIdentificador) empByFolha.set(String(emp.NumeroIdentificador).replace(/^0+/, ''), emp);
      if (emp.Cpf) empByCpf.set(String(emp.Cpf).replace(/\D/g, ''), emp);
      if (emp.Id) empById.set(Number(emp.Id), emp);
    }

    const biometrics = [];
    const total = templates.length;

    for (let i = 0; i < total; i++) {
      const t = templates[i];
      const u = userMap.get(t.user_id) || {};
      const reg = String(u.registration || t.user_id || '').replace(/^0+/, '');
      const cpf = String(u.cpf || '').replace(/\D/g, '');

      const emp = empByFolha.get(reg) || empByCpf.get(cpf) || empById.get(Number(t.user_id));
      const pessoaId = emp ? emp.Id : (u.registration || t.user_id);
      const nome = emp ? emp.Nome : (u.name || `Usuário ${t.user_id}`);
      const fingerIdx = t.finger_type !== undefined ? t.finger_type : 0;

      if (typeof onProgress === 'function') {
        onProgress(i + 1, total, nome);
      }

      biometrics.push({
        PessoaId: pessoaId,
        Tipo: 16, // Innovatrics
        Template: t.template, // Base64 string
        TemplateCodigo: `${reg || t.user_id}-${fingerIdx}`,
        Dedo: fingerIdx,
        Qualidade: 100,
        Imagem: null,
        TemplateStorageId: null,
        Nome: nome,
        Documento: cpf || reg,
      });
    }

    return {
      ok: true,
      biometrics,
      count: biometrics.length,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, biometrics: [], count: 0, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Delete specified employees and their templates from a Control iD terminal.
 * Discovered via REA in Secullum.Comunicacao.Classes.Equipamentos.ControliD.ControliDRepComunicacaoNativa.ExcluirColaboradores.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {Array<object|string>} [employees=[]]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, count: number, latencyMs: number, error?: string }>}
 */
async function deleteControlIdEmployees(ip, port = 80, employees = [], login = 'admin', password = 'admin', onProgress = null) {
  if (!employees || employees.length === 0) return { ok: true, count: 0, latencyMs: 0 };
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, count: 0, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    // 1. Load users from device to match internal user IDs
    let deviceUsers = [];
    try {
      const res = await controlIdRequest(ip, port, `load_objects.fcgi?session=${auth.session}`, {
        object: 'users',
      });
      deviceUsers = res.users || [];
    } catch {}

    // Match employee identifiers against device users
    const matchedUserIds = [];
    const targets = employees.map((emp) => {
      if (typeof emp === 'object' && emp !== null) {
        return {
          cpf: emp.Cpf ? String(emp.Cpf).replace(/\D/g, '') : '',
          pis: emp.NumeroPis ? String(emp.NumeroPis).replace(/\D/g, '') : '',
          folha: emp.NumeroFolha ? String(emp.NumeroFolha).replace(/^0+/, '') : '',
          ident: emp.NumeroIdentificador ? String(emp.NumeroIdentificador).replace(/^0+/, '') : '',
          id: emp.Id ? String(emp.Id) : '',
          name: emp.Nome ? String(emp.Nome).toLowerCase().trim() : '',
        };
      }
      const raw = String(emp).trim();
      return {
        cpf: raw.replace(/\D/g, ''),
        pis: raw.replace(/\D/g, ''),
        folha: raw.replace(/^0+/, ''),
        ident: raw.replace(/^0+/, ''),
        id: raw,
        name: raw.toLowerCase(),
      };
    });

    for (const u of deviceUsers) {
      const uCpf = String(u.cpf || '').replace(/\D/g, '');
      const uReg = String(u.registration || '').replace(/^0+/, '');
      const uId = String(u.id);
      const uName = String(u.name || '').toLowerCase().trim();

      const matched = targets.some((t) => {
        if (t.cpf && uCpf && t.cpf === uCpf) return true;
        if (t.folha && uReg && t.folha === uReg) return true;
        if (t.ident && uReg && t.ident === uReg) return true;
        if (t.id && uId && t.id === uId) return true;
        if (t.name && uName && t.name === uName) return true;
        return false;
      });

      if (matched) {
        matchedUserIds.push(u.id);
      }
    }

    if (matchedUserIds.length > 0) {
      // 2. Destroy templates of matched users
      try {
        await controlIdRequest(ip, port, `destroy_objects.fcgi?session=${auth.session}`, {
          object: 'templates',
          where: {
            templates: {
              user_id: matchedUserIds,
            },
          },
        });
      } catch {}

      // 3. Destroy users
      try {
        await controlIdRequest(ip, port, `destroy_objects.fcgi?session=${auth.session}`, {
          object: 'users',
          where: {
            users: {
              id: matchedUserIds,
            },
          },
        });
      } catch {
        // Fallback to remove_users.fcgi
        try {
          await controlIdRequest(ip, port, `remove_users.fcgi?session=${auth.session}`, {
            users: matchedUserIds.map((id) => ({ id })),
          });
        } catch {}
      }
    }

    await logoutControlId(ip, port, auth.session);
    return { ok: true, count: matchedUserIds.length, latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, count: 0, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Clear all employees and biometric templates from a Control iD terminal.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function clearControlIdEmployees(ip, port = 80, login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    try {
      await controlIdRequest(ip, port, `destroy_objects.fcgi?session=${auth.session}`, {
        object: 'templates',
      });
    } catch {}

    await controlIdRequest(ip, port, `destroy_objects.fcgi?session=${auth.session}`, {
      object: 'users',
    });

    await logoutControlId(ip, port, auth.session);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Query paper roll sensor status (EstadoBobina) from a Control iD terminal.
 * Discovered via REA from Secullum.Comunicacao.Classes.Equipamentos.ControliD.ControliDRepComunicacaoNativa.ReceberStatusBobina.
 * @param {string} ip
 * @param {number} [port=80]
 * @param {string} [login="admin"]
 * @param {string} [password="admin"]
 * @returns {Promise<{ ok: boolean, status: string, paperOk: boolean, lowPaper: boolean, remainingMeters?: number, cuts?: number, description: string, latencyMs: number, error?: string }>}
 */
async function getControlIdPaperRollStatus(ip, port = 80, login = 'admin', password = 'admin') {
  const start = Date.now();
  const auth = await loginControlId(ip, port, login, password);
  if (!auth.ok) {
    return { ok: false, status: 'Desconhecido', paperOk: false, lowPaper: false, description: 'Falha na autenticação', latencyMs: Date.now() - start, error: auth.error };
  }

  try {
    const info = await controlIdRequest(ip, port, `system_information.fcgi?session=${auth.session}`);
    await logoutControlId(ip, port, auth.session);

    const paperOk = info.paper_ok === undefined ? true : (info.paper_ok === true || info.paper_ok === 1 || String(info.paper_ok).toLowerCase() === 'ok');
    const lowPaper = info.low_paper === undefined ? false : (info.low_paper === true || info.low_paper === 1 || String(info.low_paper).toLowerCase() === 'sim');
    const remainingMeters = info.coil_paper !== undefined ? Number(info.coil_paper) : null;
    const cuts = info.cuts !== undefined ? Number(info.cuts) : null;

    let status = 'Normal';
    let description = 'Bobina em estado normal';

    if (!paperOk) {
      status = 'Sem Papel';
      description = 'Sensor indica ausência de papel (bloqueio de impressão)';
    } else if (lowPaper) {
      status = 'Pouco Papel';
      description = remainingMeters !== null
        ? `Pouco Papel - ${remainingMeters} m. restantes`
        : 'Pouco Papel - Troca necessária em breve';
    } else {
      status = 'Normal';
      if (remainingMeters !== null && cuts !== null) {
        description = `Normal - ${remainingMeters} m. restantes (${cuts} cortes)`;
      } else if (remainingMeters !== null) {
        description = `Normal - ${remainingMeters} m. restantes`;
      }
    }

    return {
      ok: true,
      status,
      paperOk,
      lowPaper,
      remainingMeters,
      cuts,
      description,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    await logoutControlId(ip, port, auth.session);
    return { ok: false, status: 'Erro', paperOk: false, lowPaper: false, description: `Erro na leitura: ${err.message}`, latencyMs: Date.now() - start, error: err.message };
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
  deleteControlIdEmployees,
  clearControlIdEmployees,
  sendControlIdEmployer,
  getControlIdEmployer,
  getControlIdBiometrics,
  getControlIdPaperRollStatus,
};

