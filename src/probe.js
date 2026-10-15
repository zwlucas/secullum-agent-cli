/**
 * probe.js - Direct LAN TCP socket probe for hardware equipment (REPs, Access Controllers).
 * Allows checking connectivity and measuring response latency without any external tools.
 * Zero external dependencies (uses native node:net).
 */

'use strict';

const net = require('node:net');

/**
 * Probe a network host and port via TCP connection.
 * @param {string} host - IP address or hostname
 * @param {number} port - TCP port number
 * @param {number} [timeout=2500] - Timeout in milliseconds
 * @returns {Promise<{ ok: boolean, latencyMs: number, error: string|null }>}
 */
function probeTcp(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    if (!host || !port) {
      return resolve({
        ok: false,
        latencyMs: 0,
        error: 'Missing host or port',
      });
    }

    const start = Date.now();
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeout);

    const finish = (ok, error = null) => {
      if (resolved) return;
      resolved = true;
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ ok, latencyMs, error });
    };

    socket.on('connect', () => {
      finish(true, null);
    });

    socket.on('timeout', () => {
      finish(false, 'Connection timed out');
    });

    socket.on('error', (err) => {
      finish(false, err.message || 'Connection refused / unreachable');
    });

    try {
      socket.connect(Number(port), host);
    } catch (err) {
      finish(false, err.message);
    }
  });
}

module.exports = {
  probeTcp,
};
