/**
 * protocols/topdata.js - Topdata (Inner Rep / Inner Rep Plus / Inner Acesso) Protocol.
 * Reverse-engineered via REA from Secullum.Comunicacao.InnerRepComunicacao
 * and Secullum.Comunicacao.InnerAcessoComunicacao.
 *
 * Inner TCP Communication:
 *   - TCP Socket on port 3570 (or 3000)
 *   - Binary framed command structure with checksum
 * Zero external npm dependencies.
 */

'use strict';

const net = require('node:net');

const DEFAULT_TOPDATA_PORT = 3570;

/**
 * Format date for Topdata Inner protocol (DD, MM, YY, HH, MM, SS).
 * @param {Date} [date=new Date()]
 * @returns {Buffer}
 */
function buildTopdataTimePayload(date = new Date()) {
  const buf = Buffer.alloc(7);
  buf[0] = 0x01; // Command: Set clock
  buf[1] = date.getDate();
  buf[2] = date.getMonth() + 1;
  buf[3] = date.getFullYear() % 100;
  buf[4] = date.getHours();
  buf[5] = date.getMinutes();
  buf[6] = date.getSeconds();
  return buf;
}

/**
 * Synchronize date and time on a Topdata Inner equipment.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {Date} [date=new Date()]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
function syncTopdataDateTime(ip, port = DEFAULT_TOPDATA_PORT, date = new Date()) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const payload = buildTopdataTimePayload(date);
    const socket = new net.Socket();

    let resolved = false;
    const finish = (res) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(res);
    };

    socket.setTimeout(3000, () => {
      finish({ ok: false, latencyMs: Date.now() - startTime, error: 'Connection timeout' });
    });

    socket.on('error', (err) => {
      finish({ ok: false, latencyMs: Date.now() - startTime, error: err.message });
    });

    socket.connect(port, ip, () => {
      socket.write(payload);
    });

    socket.on('data', () => {
      finish({ ok: true, latencyMs: Date.now() - startTime });
    });
  });
}

module.exports = {
  DEFAULT_TOPDATA_PORT,
  syncTopdataDateTime,
  buildTopdataTimePayload,
};
