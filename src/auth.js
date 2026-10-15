/**
 * cloud/auth.js - Direct OAuth2 authentication against Secullum Authenticator.
 * Endpoints discovered via REA from Secullum.Autenticacao.Client.dll:
 *   - POST https://autenticador.secullum.com.br/token
 *   - GET  https://autenticador.secullum.com.br/ContasSecullum/ListarBancos/{email}
 */

'use strict';

const { loadSession, saveSession } = require('./session');

const AUTH_BASE_URL = 'https://autenticador.secullum.com.br';
const CLIENT_ID = '3';

/**
 * Authenticate directly with Secullum Cloud using username and password.
 * @param {string} username (e-mail)
 * @param {string} password
 * @returns {Promise<object>} Token object { access_token, refresh_token, expires_in, token_type }
 */
async function authenticate(username, password) {
  const url = `${AUTH_BASE_URL}/token`;
  const bodyParams = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    client_id: CLIENT_ID,
    dont_create_refresh_token: 'false',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: bodyParams.toString(),
  });

  const data = await res.json();

  if (!res.ok) {
    const errorMsg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(errorMsg);
  }

  // Calculate expiration timestamp
  const expiresAt = Date.now() + (Number(data.expires_in) || 86400) * 1000;

  saveSession({
    usuario: username,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type,
    expiresAt,
  });

  return data;
}

/**
 * Refresh an existing OAuth token using the refresh_token.
 * @param {string} refreshToken
 * @returns {Promise<object>}
 */
async function refreshAuthToken(refreshToken) {
  const url = `${AUTH_BASE_URL}/token`;
  const bodyParams = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: bodyParams.toString(),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to refresh token');
  }

  const expiresAt = Date.now() + (Number(data.expires_in) || 86400) * 1000;

  saveSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
  });

  return data;
}

/**
 * Get a valid access token from session, automatically refreshing if close to expiry.
 * @returns {Promise<string>}
 */
async function getValidAccessToken() {
  const session = loadSession();
  if (!session || !session.accessToken) {
    throw new Error('No cloud session found. Please run: secullum-agent-cli login');
  }

  // Check if token expires within 5 minutes
  if (session.expiresAt && Date.now() > session.expiresAt - 300000) {
    if (session.refreshToken) {
      const refreshed = await refreshAuthToken(session.refreshToken);
      return refreshed.access_token;
    }
  }

  return session.accessToken;
}

/**
 * Retrieve all company databases associated with the authenticated account from PontoWeb Toolbar.
 * @param {string} [accessToken]
 * @returns {Promise<Array<object>>}
 */
async function listDatabases(accessToken) {
  const token = accessToken || (await getValidAccessToken());
  const url = 'https://pontoweb.secullum.com.br/Toolbar';

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'secullumversaoagente': '1.54.0.0',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list databases (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (data.nome) {
    saveSession({ nome: data.nome });
  }

  return data.listaBancos || [];
}

module.exports = {
  AUTH_BASE_URL,
  CLIENT_ID,
  authenticate,
  refreshAuthToken,
  getValidAccessToken,
  listDatabases,
};
