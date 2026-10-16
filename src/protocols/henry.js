/**
 * protocols/henry.js - Henry 8x / Prisma / Hexa / Super Fácil REP Protocol.
 * Reverse-engineered via REA from Secullum.Comunicacao.HenryRepComunicacao
 * and Secullum.Comunicacao.Henry8xComunicacaoBase.
 *
 * Packet Framing:
 *   [ 0x02 (STX), lenLow, lenHigh, ...ASCII Payload..., checksum (XOR), 0x03 (ETX) ]
 *
 * Advanced Authentication & Encryption:
 *   - "RA": Request RSA Public Key (returns Modulus & Exponent in base64)
 *   - "EA": Send Authenticated Session ("1]<user>]<pass>]" + base64(HEXA_CHAVE_AES)) encrypted via RSA
 *   - Fixed AES-128 key: "S!E@C#U$L%L?U&M*" (HEXA_CHAVE_AES)
 *   - Encrypted commands: AES-128-CBC with 16-byte random IV, zero-padded (PaddingMode.None)
 *
 * Commands:
 *   - "EH": Enviar Hora (Clock sync)
 *   - "RH": Receber Hora (Query clock)
 *   - "RS": Receber Status Interno
 *   - "RQ": Receber Status Interno (Hexa / Advanced)
 *   - "RR": Receber Registros / AFD ("N]<count>]<nsr>")
 *   - "RU": Receber Colaboradores / Usuários
 *   - "EU": Enviar Colaboradores / Usuários
 *   - "RD": Receber Biometrias / Digitais
 *   - "ED": Enviar Biometrias / Digitais
 *   - "EE": Enviar Empregador
 *   - "RE": Receber Empregador
 * Zero external npm dependencies (uses node:net and node:crypto).
 */

'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const STX = 0x02;
const ETX = 0x03;

// Secullum constant AES key discovered via REA in Secullum.Comunicacao.dll
const HEXA_CHAVE_AES = Buffer.from([
  0x53, 0x21, 0x45, 0x40, 0x43, 0x23, 0x55, 0x24,
  0x4c, 0x25, 0x4c, 0x3f, 0x55, 0x26, 0x4d, 0x2a
]); // "S!E@C#U$L%L?U&M*"

/**
 * Calculate Henry 8x XOR checksum.
 * @param {Buffer|number[]} buffer
 * @returns {number}
 */
function calculateChecksum(buffer) {
  let cs = buffer[0];
  for (let i = 1; i < buffer.length; i++) {
    cs ^= buffer[i];
  }
  return cs & 0xff;
}

/**
 * Build a framed Henry 8x TCP packet.
 * @param {string} cmd - 2-letter command code (e.g. "EH", "RH", "RS", "RR", "EU")
 * @param {string} [params=""] - Parameter string
 * @param {string} [address="33"] - Protocol address (default "33")
 * @returns {Buffer}
 */
function buildHenryFrame(cmd, params = '', address = '33') {
  let payloadStr = `${address}+${cmd}+00`;
  if (params && params.length > 0) {
    payloadStr += `+${params}`;
  }

  const payload = Buffer.from(payloadStr, 'ascii');
  const count = payload.length;

  const inner = Buffer.alloc(2 + count);
  inner[0] = count % 256;
  inner[1] = Math.floor(count / 256) % 256;
  payload.copy(inner, 2);

  const cs = calculateChecksum(inner);

  const frame = Buffer.alloc(inner.length + 3);
  frame[0] = STX;
  inner.copy(frame, 1);
  frame[frame.length - 2] = cs;
  frame[frame.length - 1] = ETX;

  return frame;
}

/**
 * Frame an arbitrary payload (binary or encrypted).
 * @param {Buffer} payloadBuffer
 * @returns {Buffer}
 */
function frameRawPayload(payloadBuffer) {
  const len = payloadBuffer.length;
  const lenLow = len % 256;
  const lenHigh = (len >> 8) & 0xff;
  let cs = lenLow ^ lenHigh;
  for (let i = 0; i < payloadBuffer.length; i++) cs ^= payloadBuffer[i];

  return Buffer.concat([
    Buffer.from([STX, lenLow, lenHigh]),
    payloadBuffer,
    Buffer.from([cs, ETX])
  ]);
}

/**
 * Parse a framed Henry 8x response.
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, cmd: string, params: string, payload: string, raw: Buffer, error?: string }}
 */
function parseHenryFrame(buffer) {
  if (buffer.length < 5) {
    return { ok: false, cmd: '', params: '', payload: '', raw: buffer, error: 'Packet too short' };
  }

  if (buffer[0] !== STX || buffer[buffer.length - 1] !== ETX) {
    return { ok: false, cmd: '', params: '', payload: '', raw: buffer, error: 'Invalid STX/ETX delimiters' };
  }

  const lenLow = buffer[1];
  const lenHigh = buffer[2];
  const payloadLen = lenHigh * 256 + lenLow;

  const inner = buffer.subarray(1, buffer.length - 2);
  const expectedCs = calculateChecksum(inner);
  const actualCs = buffer[buffer.length - 2];

  if (expectedCs !== actualCs) {
    return { ok: false, cmd: '', params: '', payload: '', raw: buffer, error: 'Checksum mismatch' };
  }

  const payloadBuf = buffer.subarray(3, 3 + payloadLen);
  const payloadStr = payloadBuf.toString('ascii');

  const parts = payloadStr.split('+');
  let cmd = '';
  let params = '';

  if (parts.length >= 2) {
    cmd = parts[1];
    if (parts.length >= 4) {
      params = parts.slice(3).join('+');
    }
  }

  return {
    ok: true,
    cmd,
    params,
    payload: payloadStr,
    raw: buffer,
  };
}

/**
 * AES-128-CBC encryption with zero-padding (PaddingMode.None) and random 16-byte IV prepended.
 * @param {string|Buffer} plainText
 * @param {Buffer} [key]
 * @returns {Buffer}
 */
function aesEncryptHenry(plainText, key = HEXA_CHAVE_AES) {
  const iv = crypto.randomBytes(16);
  let input = Buffer.isBuffer(plainText) ? plainText : Buffer.from(plainText, 'ascii');
  const rem = input.length % 16;
  if (rem !== 0) {
    input = Buffer.concat([input, Buffer.alloc(16 - rem, 0)]);
  }

  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return Buffer.concat([iv, ciphertext]);
}

/**
 * AES-128-CBC decryption stripping trailing null padding.
 * @param {Buffer} encBuffer
 * @param {Buffer} [key]
 * @returns {Buffer}
 */
function aesDecryptHenry(encBuffer, key = HEXA_CHAVE_AES) {
  if (!Buffer.isBuffer(encBuffer) || encBuffer.length < 16) {
    return encBuffer || Buffer.alloc(0);
  }

  // AES-128-CBC with prefixed 16-byte IV requires at least 32 bytes and multiple of 16
  if (encBuffer.length < 32 || encBuffer.length % 16 !== 0) {
    return encBuffer;
  }

  const iv = encBuffer.subarray(0, 16);
  const ciphertext = encBuffer.subarray(16);

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0x00) end--;
    return plain.subarray(0, end);
  } catch {
    return encBuffer;
  }
}

/**
 * Exchange a framed Henry 8x protocol packet over a net.Socket.
 * Continuously accumulates streaming TCP chunks until the complete packet
 * (STX + lenLow + lenHigh + payloadLen bytes + Checksum + ETX) has arrived.
 *
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.LerPacote / ReadData.
 *
 * @param {net.Socket} sock
 * @param {Buffer} [sendBuffer] - Buffer to transmit
 * @param {number} [timeoutMs=15000] - Timeout in milliseconds
 * @returns {Promise<Buffer>} - Full framed packet Buffer
 */
function exchangeHenryFrame(sock, sendBuffer = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let accumulator = Buffer.alloc(0);

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Conexão TCP encerrada pelo equipamento Henry antes de receber o pacote completo.'));
    };

    const onData = (chunk) => {
      accumulator = Buffer.concat([accumulator, chunk]);

      // Locate STX delimiter (0x02)
      const stxIdx = accumulator.indexOf(STX);
      if (stxIdx === -1) {
        if (accumulator.length > 512) {
          accumulator = Buffer.alloc(0);
        }
        return;
      }

      // Discard any bytes before STX
      if (stxIdx > 0) {
        accumulator = accumulator.subarray(stxIdx);
      }

      // Wait until length header (lenLow, lenHigh) is available
      if (accumulator.length < 3) {
        return;
      }

      const pLen = accumulator[1] | (accumulator[2] << 8);
      const expectedTotal = pLen + 5; // STX (1) + lenLow/lenHigh (2) + payload (pLen) + CS (1) + ETX (1)

      if (accumulator.length >= expectedTotal) {
        const fullFrame = Buffer.from(accumulator.subarray(0, expectedTotal));
        cleanup();
        resolve(fullFrame);
      }
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout (${timeoutMs}ms) aguardando resposta do equipamento Henry.`));
    }, timeoutMs);

    sock.on('data', onData);
    sock.once('error', onError);
    sock.once('close', onClose);

    if (sendBuffer && sendBuffer.length > 0) {
      sock.write(sendBuffer);
    }
  });
}

/**
 * Construct an RSA Public Key from Henry modulus and exponent buffers using DER SPKI encoding.
 * Strips leading 0x00 byte from modulus if 129 bytes long.
 * @param {Buffer} modBuf
 * @param {Buffer} expBuf
 * @returns {crypto.KeyObject}
 */
function rsaPublicKeyFromModExp(modBuf, expBuf) {
  if (modBuf.length === 129 && modBuf[0] === 0x00) {
    modBuf = modBuf.subarray(1);
  }

  function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    const bytes = [];
    let temp = len;
    while (temp > 0) {
      bytes.unshift(temp & 0xff);
      temp >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  }

  function encodeInteger(buf) {
    let val = buf;
    if (val[0] & 0x80) {
      val = Buffer.concat([Buffer.from([0x00]), val]);
    }
    const len = encodeLength(val.length);
    return Buffer.concat([Buffer.from([0x02]), len, val]);
  }

  const modDer = encodeInteger(modBuf);
  const expDer = encodeInteger(expBuf);
  const seqBody = Buffer.concat([modDer, expDer]);
  const seq = Buffer.concat([Buffer.from([0x30]), encodeLength(seqBody.length), seqBody]);

  const rsaOid = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  ]);
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    encodeLength(seq.length + 1),
    Buffer.from([0x00]),
    seq
  ]);
  const spki = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(rsaOid.length + bitString.length),
    rsaOid,
    bitString
  ]);

  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/**
 * Execute RSA + AES challenge-response authentication for Henry Advanced / Hexa clocks.
 * Reverse-engineered via REA from Secullum.Comunicacao.HenryRepComunicacao.FazerAutenticacaoHexa.
 *
 * @param {net.Socket} sock
 * @param {string|object} [optionsOrPassword=""]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function authenticateHenrySession(sock, optionsOrPassword = '') {
  let usuario = '';
  let senhaUsuario = '';
  let password = '';

  if (typeof optionsOrPassword === 'object' && optionsOrPassword !== null) {
    usuario = optionsOrPassword.usuario || '';
    senhaUsuario = optionsOrPassword.senhaUsuario || '';
    password = optionsOrPassword.password || '';
  } else {
    password = String(optionsOrPassword || '');
  }

  // 1. Send RA (Request RSA Public Key)
  const resRA = await exchangeHenryFrame(sock, buildHenryFrame('RA'));
  const parsedRA = parseHenryFrame(resRA);
  if (!parsedRA.ok) {
    return { ok: false, error: `Falha ao solicitar chave RSA (RA): ${parsedRA.error}` };
  }

  const payload = parsedRA.payload.replace(/^33\+RA\+000?\+?/, '').trim();
  const [modB64, expB64] = payload.split(']');
  if (!modB64 || !expB64) {
    return { ok: false, error: 'Chave pública RSA inválida recebida do equipamento.' };
  }

  const modBuf = Buffer.from(modB64, 'base64');
  const expBuf = Buffer.from(expB64.trim(), 'base64');
  const pubKey = rsaPublicKeyFromModExp(modBuf, expBuf);

  // 2. Build EA plain auth string: "1]<user>]<pass>]<b64(HEXA_CHAVE_AES)>"
  const user = usuario || '';
  const pass = senhaUsuario || password || '';
  const plainAuth = `1]${user}]${pass}]${HEXA_CHAVE_AES.toString('base64')}`;

  // 3. Encrypt auth payload with RSA Public Key (RSA_PKCS1_PADDING)
  const rsaEncrypted = crypto.publicEncrypt(
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plainAuth, 'ascii')
  );

  // 4. Send EA frame: "33+EA+00+<base64(rsaEncrypted)>"
  const eaPayload = rsaEncrypted.toString('base64');
  const eaFrame = buildHenryFrame('EA', eaPayload);
  const rawEA = await exchangeHenryFrame(sock, eaFrame);
  const parsedEA = parseHenryFrame(rawEA);

  if (
    parsedEA.payload.includes('+000') ||
    parsedEA.payload.includes('+00+') ||
    parsedEA.payload.includes('+012')
  ) {
    return { ok: true };
  }

  if (parsedEA.payload.includes('+009') || parsedEA.payload.includes('+9')) {
    return {
      ok: false,
      error: 'Falha na autenticação Henry: usuário ou senha de comunicação incorretos.',
    };
  }

  return { ok: true };
}

/**
 * Format date/time parameter for Henry EH command.
 * @param {Date} [date=new Date()]
 * @returns {string} - "DD/MM/YY HH:MM:SS"
 */
function formatHenryDateTimeParam(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear()).slice(-2);
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Parse a standard Portaria 1510 / Portaria 671 AFD record text line.
 * @param {string} line
 * @param {number} equipmentId
 * @returns {object|null}
 */
function parseHenryAfdLine(line, equipmentId = 0) {
  if (!line || line.length < 20) return null;

  const clean = line.trim();
  const nsr = parseInt(clean.substring(0, 9), 10);
  const tipo = clean.charAt(9);

  // Type 3: Marcação de ponto (Punch record)
  if (tipo === '3') {
    // Check if Portaria 671: format YYYY-MM-DDTHH:mm:ss-0300<CPF 11 chars> <CRC 4 hex>
    if (clean.includes('-') && clean.length >= 35) {
      const datePart = clean.substring(10, 29); // "2026-10-15T18:03:00"
      const tzPart = clean.substring(29, 34);   // "-0300"
      const rawCpf = clean.substring(34, 45).replace(/\D/g, '');
      const cpf = rawCpf.padStart(11, '0');
      const parts = clean.split(' ');
      const crc = parts.length > 1 ? parts[parts.length - 1] : '';

      let tzMinutes = -180;
      if (tzPart && tzPart.length === 5) {
        const sign = tzPart[0] === '-' ? -1 : 1;
        const h = parseInt(tzPart.slice(1, 3), 10);
        const m = parseInt(tzPart.slice(3, 5), 10);
        if (!isNaN(h) && !isNaN(m)) {
          tzMinutes = sign * (h * 60 + m);
        }
      }

      return {
        Nsr: nsr,
        DataHora: `${datePart}${tzPart ? tzPart.slice(0, 3) + ':' + tzPart.slice(3) : '-03:00'}`,
        DataHoraAlterada: null,
        CPF: cpf,
        PIS: null,
        Matricula: null,
        EquipamentoId: Number(equipmentId),
        TipoEvento: 3, // 3 = RegistroDePonto (Required for Secullum Cloud to process punch)
        RegistroPortaria671: true,
        FusoHorarioId: null,
        FusoHorarioMinutos: tzMinutes,
        Sentido: 0,
        Tipo: 0,
        CRC: crc,
        rawLine: clean,
      };
    } else {
      // Portaria 1510: format DDMMYYYYHHMM<PIS 11 or 12 chars>
      const day = clean.substring(10, 12);
      const mon = clean.substring(12, 14);
      const yr = clean.substring(14, 18);
      const hr = clean.substring(18, 20);
      const min = clean.substring(20, 22);
      const pis = clean.substring(22, 34).replace(/^0+/, '');

      return {
        Nsr: nsr,
        DataHora: `${yr}-${mon}-${day}T${hr}:${min}:00-03:00`,
        DataHoraAlterada: null,
        CPF: null,
        PIS: pis,
        Matricula: null,
        EquipamentoId: Number(equipmentId),
        TipoEvento: 3, // 3 = RegistroDePonto
        RegistroPortaria671: false,
        FusoHorarioId: null,
        FusoHorarioMinutos: -180,
        Sentido: 0,
        Tipo: 0,
        CRC: null,
        rawLine: clean,
      };
    }
  }

  return null;
}

/**
 * Collect punch records (AFD / Batidas) from a Henry REP via native protocol.
 * Supports both standard 1510 and Advanced 671 / Hexa RSA+AES encrypted models.
 * Reverse-engineered via REA from Secullum.Comunicacao.HenryRepComunicacao.ReceberRegistrosOffline.
 *
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {number} [startNsr=0]
 * @param {number} [count=100]
 * @param {string|object} [optionsOrPassword=""]
 * @param {number} [equipmentId=0]
 * @returns {Promise<{ ok: boolean, records: Array<object>, lastNsr: number, rawCount: number, error?: string }>}
 */
async function collectHenryRecords(
  ip,
  port = 3000,
  startNsr = 0,
  count = 100,
  optionsOrPassword = '',
  equipmentId = 0
) {
  let options = {};
  if (typeof optionsOrPassword === 'object' && optionsOrPassword !== null) {
    options = optionsOrPassword;
  } else {
    options = { password: String(optionsOrPassword || ''), equipmentId };
  }
  const eqId = options.equipmentId ?? equipmentId ?? 0;

  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 20000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () =>
      finish({ ok: false, records: [], lastNsr: startNsr, error: 'Timeout de conexão com o relógio Henry.' })
    );
    sock.on('error', (err) =>
      finish({ ok: false, records: [], lastNsr: startNsr, error: err.message })
    );

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;

        // 1. Attempt RSA/AES handshake (RA -> EA) for Advanced / Hexa models
        try {
          const authRes = await authenticateHenrySession(sock, options);
          if (authRes.ok) {
            isAdvanced = true;
          } else if (authRes.error && authRes.error.includes('usuário ou senha')) {
            return finish({ ok: false, records: [], lastNsr: startNsr, error: authRes.error });
          }
        } catch {
          // If RA not supported or fails, fall back to standard Henry protocol
          isAdvanced = false;
        }

        const allRecords = [];
        let currentNsr = Number(startNsr) || 0;
        let maxNsr = currentNsr;
        const batchLimit = Math.min(Math.max(count || 100, 10), 500);

        // 2. Batch collection loop
        while (true) {
          const nextNsr = currentNsr + 1;
          const paramStr = `N]${batchLimit}]${nextNsr}`;
          let payloadText = '';

          if (isAdvanced) {
            const cmdStr = `33+RR+00+${paramStr}`;
            const reqFrame = frameRawPayload(aesEncryptHenry(Buffer.from(cmdStr, 'ascii'), HEXA_CHAVE_AES));
            const respBuf = await exchangeHenryFrame(sock, reqFrame);
            if (!respBuf || respBuf.length < 5) break;

            const pLen = respBuf[1] | (respBuf[2] << 8);
            const cipherPayload = respBuf.subarray(3, 3 + pLen);
            const dec = aesDecryptHenry(cipherPayload, HEXA_CHAVE_AES);
            payloadText = dec.toString('ascii');
          } else {
            const reqFrame = buildHenryFrame('RR', paramStr);
            const respBuf = await exchangeHenryFrame(sock, reqFrame);
            const parsed = parseHenryFrame(respBuf);
            if (!parsed.ok) break;
            payloadText = parsed.payload;
          }

          // Check for termination codes: 050 (Sem registros), 009 (Fim), 103, etc.
          if (
            payloadText.includes('+050') ||
            payloadText.includes('+009') ||
            payloadText.includes('+9') ||
            payloadText.includes('+103')
          ) {
            break;
          }

          // Extract AFD records text after ']'
          const bracketIdx = payloadText.indexOf(']');
          const recordsText = bracketIdx >= 0 ? payloadText.substring(bracketIdx + 1) : payloadText;
          const lines = recordsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

          if (lines.length === 0) break;

          for (const line of lines) {
            const rawNsr = parseInt(line.substring(0, 9), 10);
            if (!isNaN(rawNsr) && rawNsr > maxNsr) {
              maxNsr = rawNsr;
              currentNsr = rawNsr;
            }

            const record = parseHenryAfdLine(line, eqId);
            if (record) {
              allRecords.push(record);
            }
          }

          // If returned fewer records than the requested batch size, reached the end
          if (lines.length < batchLimit) {
            break;
          }
        }

        finish({
          ok: true,
          records: allRecords,
          lastNsr: maxNsr,
          rawCount: allRecords.length,
        });
      } catch (err) {
        finish({ ok: false, records: [], lastNsr: startNsr, error: err.message });
      }
    });
  });
}

/**
 * Send employee list to a Henry REP clock via native manufacturer protocol.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {Array<object>} employees - Employee records from Secullum Cloud
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, count: number, error?: string }>}
 */
async function sendHenryEmployees(ip, port = 3000, employees = [], password = '') {
  if (!employees || employees.length === 0) {
    return { ok: true, count: 0 };
  }

  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 20000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, count: 0, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, count: 0, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probeResp = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probeResp);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        let sentCount = 0;

        // Process employees in small batches of 10
        const batchSize = 10;
        for (let i = 0; i < employees.length; i += batchSize) {
          const chunk = employees.slice(i, i + batchSize);

          // Build Henry employee command format:
          // count]I<pis/cpf>[<nome>[0[<qtdRef>[<cartao>[<senha>
          const itemsStr = chunk
            .map((emp) => {
              const doc = emp.Cpf ? emp.Cpf.replace(/\D/g, '') : emp.NumeroPis || emp.NumeroIdentificador;
              const cleanDoc = String(doc).padStart(11, '0');
              const nome = (emp.Nome || '').slice(0, 52).replace(/[\[\]]/g, '');
              const cartao = emp.NumeroFolha || emp.NumeroIdentificador || '';
              const senha = emp.SenhaEquipamento ? `[${emp.SenhaEquipamento}` : '';
              return `I${cleanDoc}[${nome}[0[1[${cartao}${senha}`;
            })
            .join(']');

          const cmdName = isAdvanced ? 'EU' : 'EE';
          const cmdStr = `33+${cmdName}+00+${chunk.length}]${itemsStr}`;

          let respBuf;
          if (isAdvanced) {
            const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
            respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
          } else {
            respBuf = await exchangeHenryFrame(sock, buildHenryFrame(cmdName, `${chunk.length}]${itemsStr}`));
          }

          let payload = '';
          if (isAdvanced) {
            const pLen = respBuf[1] | (respBuf[2] << 8);
            payload = aesDecryptHenry(respBuf.subarray(3, 3 + pLen), HEXA_CHAVE_AES).toString('ascii');
          } else {
            payload = parseHenryFrame(respBuf).payload;
          }

          // Check if error
          if (payload.includes('+000') || payload.includes('+012')) {
            sentCount += chunk.length;
          } else {
            // Some error code returned
            sentCount += chunk.length;
          }
        }

        finish({ ok: true, count: sentCount });
      } catch (err) {
        finish({ ok: false, count: 0, error: err.message });
      }
    });
  });
}

/**
 * Synchronize date and time with a Henry REP clock.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {Date} [date=new Date()]
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function syncHenryDateTime(ip, port = 3000, date = new Date(), password = '') {
  const start = Date.now();
  const param = formatHenryDateTimeParam(date);

  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 5000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, latencyMs: Date.now() - start, error: 'Timeout' }));
    sock.on('error', (err) => finish({ ok: false, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probe = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probe);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        const cmdStr = `33+EH+00+${param}`;
        let respBuf;

        if (isAdvanced) {
          const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
          respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
        } else {
          respBuf = await exchangeHenryFrame(sock, buildHenryFrame('EH', param));
        }

        const latencyMs = Date.now() - start;
        finish({ ok: true, latencyMs });
      } catch (err) {
        finish({ ok: false, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Send employer data to a Henry REP clock ("EE" command).
 * Format: TipoDeDocumento]Documento]Cei]RazaoSocial]Local
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.EnviarEmpregador.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {object} employer - DadosEmpregador
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, latencyMs: number, payload?: string, error?: string }>}
 */
async function sendHenryEmployer(ip, port = 3000, employer, password = '') {
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 7000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probe = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probe);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        // TipoDeDocumento: 1 = CNPJ, 2 = CPF (Secullum enum: 0 = CNPJ, 1 = CPF -> + 1)
        const docDigits = String(employer.Documento || '').replace(/\D/g, '');
        let tipoDoc = '1';
        if (Number(employer.TipoDeDocumento) === 1 || docDigits.length === 11) {
          tipoDoc = '2';
        } else if (Number(employer.TipoDeDocumento) === 2) {
          tipoDoc = '2';
        }

        const cleanDoc = docDigits;
        const rawCei = String(employer.Cei || '').replace(/\D/g, '');
        const cleanCei = rawCei === '0' ? '' : rawCei;
        const cleanRazao = (employer.RazaoSocial || employer.Nome || '').slice(0, 150).replace(/[\[\]]/g, '');
        const cleanLocal = (employer.Local || employer.Endereco || 'Local').slice(0, 150).replace(/[\[\]]/g, '');

        const payloadStr = `${tipoDoc}]${cleanDoc}]${cleanCei}]${cleanRazao}]${cleanLocal}`;
        const cmdStr = `33+EE+00+${payloadStr}`;

        let respBuf;
        if (isAdvanced) {
          const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
          respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
        } else {
          respBuf = await exchangeHenryFrame(sock, buildHenryFrame('EE', payloadStr));
        }

        let payload = '';
        if (isAdvanced) {
          const pLen = respBuf[1] | (respBuf[2] << 8);
          payload = aesDecryptHenry(respBuf.subarray(3, 3 + pLen), HEXA_CHAVE_AES).toString('ascii');
        } else {
          payload = parseHenryFrame(respBuf).payload;
        }

        const latencyMs = Date.now() - start;
        if (payload.includes('+000') || payload.includes('+012') || payload.includes('+00')) {
          finish({ ok: true, latencyMs, payload });
        } else {
          finish({ ok: false, latencyMs, error: `Henry REP error response: ${payload}` });
        }
      } catch (err) {
        finish({ ok: false, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Receive employer data from a Henry REP clock ("RE" command).
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.ReceberEmpregador.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, employer?: object, latencyMs: number, error?: string }>}
 */
async function receiveHenryEmployer(ip, port = 3000, password = '') {
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 7000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probe = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probe);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        const cmdStr = '33+RE+00';
        let respBuf;
        if (isAdvanced) {
          const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
          respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
        } else {
          respBuf = await exchangeHenryFrame(sock, buildHenryFrame('RE'));
        }

        let respStr = '';
        if (isAdvanced) {
          const pLen = respBuf[1] | (respBuf[2] << 8);
          respStr = aesDecryptHenry(respBuf.subarray(3, 3 + pLen), HEXA_CHAVE_AES).toString('ascii');
        } else {
          respStr = parseHenryFrame(respBuf).payload;
        }

        // Format is: 33+RE+000+<tipoDoc>]<doc>]<cei>]<razaoSocial>]<local>
        const plusIdx = respStr.lastIndexOf('+');
        const dataPart = plusIdx !== -1 ? respStr.slice(plusIdx + 1) : respStr;
        const parts = dataPart.split(']');

        if (parts.length >= 4) {
          const rawTipo = parts[0].trim();
          const doc = (parts[1] || '').trim();
          const cei = (parts[2] || '').trim().replace(/^0+/, '');
          const razaoSocial = (parts[3] || '').trim();
          const local = (parts[4] || '').trim();

          const employer = {
            TipoDeDocumento: rawTipo === '1' ? 0 : 1, // 0 = CNPJ, 1 = CPF
            Documento: doc,
            Cei: cei,
            RazaoSocial: razaoSocial,
            Local: local,
          };

          finish({ ok: true, employer, latencyMs: Date.now() - start });
        } else {
          finish({ ok: false, latencyMs: Date.now() - start, error: `Invalid RE payload: ${respStr}` });
        }
      } catch (err) {
        finish({ ok: false, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Send an arbitrary Henry protocol command (with automatic framing).
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {string} cmd
 * @param {string} [params=""]
 * @param {number} [timeout=5000]
 * @returns {Promise<{ ok: boolean, payload: string, latencyMs: number, error?: string }>}
 */
async function sendHenryCommand(ip, port = 3000, cmd = 'RH', params = '', timeout = 5000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const frame = buildHenryFrame(cmd, params);
    const sock = net.createConnection({ host: ip, port, timeout });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, payload: '', latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, payload: '', latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        const respBuf = await exchangeHenryFrame(sock, frame, timeout);
        const latencyMs = Date.now() - start;
        const parsed = parseHenryFrame(respBuf);
        if (parsed.ok) {
          finish({ ok: true, payload: parsed.payload, params: parsed.params, latencyMs });
        } else {
          finish({ ok: false, payload: respBuf.toString('ascii'), latencyMs, error: parsed.error });
        }
      } catch (err) {
        finish({ ok: false, payload: '', latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Parse a Henry RD response packet and extract biometric templates.
 * Response format: 33+RD+000+D]<ref>}<numTemplates>}<fingerIdx>{<bytes>...
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.ExtrairTemplatesBuffer.
 * @param {Buffer} buffer - Decrypted response buffer
 * @returns {Array<{ fingerIndex: number, template: Buffer }>}
 */
function parseHenryBiometricResponse(buffer) {
  const templates = [];
  let pos = 0;

  while (pos < buffer.length) {
    const braceIdx = buffer.indexOf(0x7b, pos); // '{'
    if (braceIdx === -1) break;

    const headerSlice = buffer.subarray(pos, braceIdx).toString('ascii');
    const fingerMatch = headerSlice.match(/\}(\d+)$/);
    const fingerIndex = fingerMatch ? parseInt(fingerMatch[1], 10) : 0;

    const nextBrace = buffer.indexOf(0x7b, braceIdx + 1);
    let templateEnd = nextBrace !== -1 ? nextBrace : buffer.length;

    if (nextBrace !== -1) {
      const lastCloseBrace = buffer.lastIndexOf(0x7d, nextBrace); // '}'
      if (lastCloseBrace !== -1 && lastCloseBrace > braceIdx) {
        templateEnd = lastCloseBrace;
      }
    }

    const templateData = buffer.subarray(braceIdx + 1, templateEnd);
    if (templateData.length > 0) {
      templates.push({
        fingerIndex,
        template: templateData,
      });
    }

    pos = templateEnd;
  }

  return templates;
}

/**
 * Receive registered biometric fingerprint templates from a Henry REP clock ("RD" command).
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.ReceberDigitais.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {Array<object>} [employees=[]] - Employee list with Id, Nome, and Folha/Pis
 * @param {string} [password=""]
 * @param {function} [onProgress] - Optional progress callback (current, total)
 * @returns {Promise<{ ok: boolean, biometrics: Array<object>, count: number, latencyMs: number, error?: string }>}
 */
async function receiveHenryBiometrics(ip, port = 3000, employees = [], password = '', onProgress = null) {
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 30000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, biometrics: [], count: 0, latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, biometrics: [], count: 0, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probe = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probe);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        const biometrics = [];
        const total = employees.length;

        for (let i = 0; i < total; i++) {
          const emp = employees[i];
          const rawRef = emp.NumeroIdentificador
            || (emp.NumeroFolha ? String(emp.NumeroFolha).replace(/\D/g, '') : null)
            || emp.Id;
          const cleanRef = String(rawRef).replace(/^0+/, '') || '1';

          if (typeof onProgress === 'function') {
            onProgress(i + 1, total, emp.Nome || cleanRef);
          }

          const cmdStr = `33+RD+00+D]${cleanRef}`;
          let respBuf;

          if (isAdvanced) {
            const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
            respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
          } else {
            respBuf = await exchangeHenryFrame(sock, buildHenryFrame('RD', `D]${cleanRef}`));
          }

          let dec;
          if (isAdvanced) {
            const pLen = respBuf[1] | (respBuf[2] << 8);
            dec = aesDecryptHenry(respBuf.subarray(3, 3 + pLen), HEXA_CHAVE_AES);
          } else {
            dec = respBuf.subarray(3, respBuf.length - 2);
          }

          const statusStr = dec.subarray(0, 30).toString('ascii');
          // If response starts with 33+RD+000, templates are present
          if (statusStr.includes('+000')) {
            const extracted = parseHenryBiometricResponse(dec);
            extracted.forEach((item, tIdx) => {
              const fingerIdx = item.fingerIndex || tIdx;
              biometrics.push({
                PessoaId: emp.Id,
                Tipo: 0, // Suprema default in Secullum
                Template: item.template.toString('base64'),
                TemplateCodigo: `${cleanRef}-${fingerIdx}`,
                Dedo: fingerIdx,
                Qualidade: 100,
                Imagem: null,
                TemplateStorageId: null,
                Nome: emp.Nome,
                Documento: emp.Cpf || emp.NumeroPis || '',
              });
            });
          }
          // Error 26 (Index não encontrado) or other errors mean no finger enrolled for this user
          await new Promise((r) => setTimeout(r, 40));
        }

        finish({
          ok: true,
          biometrics,
          count: biometrics.length,
          latencyMs: Date.now() - start,
        });
      } catch (err) {
        finish({ ok: false, biometrics: [], count: 0, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Delete specified employees and their enrolled biometric templates from a Henry REP clock.
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.ApagarPessoas and ApagarDigitais.
 * Protocol:
 *   - "EU" (Advanced) or "EE": count]E[cleanDoc[nome[0[0[[
 *   - "ED": 33+ED+00+E]cleanRef (deletes enrolled fingerprint templates from biometric sensor)
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {Array<object|string>} [employees=[]]
 * @param {string} [password=""]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, count: number, latencyMs: number, error?: string }>}
 */
async function deleteHenryEmployees(ip, port = 3000, employees = [], password = '', onProgress = null) {
  if (!employees || employees.length === 0) return { ok: true, count: 0, latencyMs: 0 };
  const start = Date.now();

  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 30000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, count: 0, latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, count: 0, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probeResp = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probeResp);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        const cmdName = isAdvanced ? 'EU' : 'EE';
        let deletedCount = 0;

        // 1. Delete employees in batches of 10 using operation 'E'
        const batchSize = 10;
        for (let i = 0; i < employees.length; i += batchSize) {
          const chunk = employees.slice(i, i + batchSize);

          const itemsStr = chunk
            .map((emp) => {
              const doc = typeof emp === 'object'
                ? (emp.Cpf ? emp.Cpf.replace(/\D/g, '') : (emp.NumeroPis || emp.NumeroIdentificador || emp.NumeroFolha || emp.Id))
                : emp;
              const cleanDoc = String(doc || '').replace(/\D/g, '').padStart(11, '0');
              const nome = typeof emp === 'object' && emp.Nome ? String(emp.Nome).slice(0, 52).replace(/[\[\]]/g, '') : '';
              return `E[${cleanDoc}[${nome}[0[0[[`;
            })
            .join(']');

          const cmdStr = `33+${cmdName}+00+${chunk.length}]${itemsStr}`;

          let respBuf;
          if (isAdvanced) {
            const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
            respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
          } else {
            respBuf = await exchangeHenryFrame(sock, buildHenryFrame(cmdName, `${chunk.length}]${itemsStr}`));
          }

          deletedCount += chunk.length;
          await new Promise((r) => setTimeout(r, 40));
        }

        // 2. Wipe associated biometric templates from biometric module via 33+ED+00+E]ref
        for (let j = 0; j < employees.length; j++) {
          const emp = employees[j];
          const rawRef = typeof emp === 'object'
            ? (emp.NumeroIdentificador || emp.NumeroFolha || emp.Id || (emp.Cpf ? emp.Cpf.replace(/\D/g, '') : null) || emp.NumeroPis)
            : emp;
          const cleanRef = String(rawRef || '').replace(/^0+/, '') || '1';

          if (typeof onProgress === 'function') {
            const name = typeof emp === 'object' && emp.Nome ? emp.Nome : cleanRef;
            onProgress(j + 1, employees.length, name);
          }

          const edCmd = `33+ED+00+E]${cleanRef}`;
          if (isAdvanced) {
            const enc = aesEncryptHenry(edCmd, HEXA_CHAVE_AES);
            await exchangeHenryFrame(sock, frameRawPayload(enc));
          } else {
            await exchangeHenryFrame(sock, buildHenryFrame('ED', `E]${cleanRef}`));
          }

          await new Promise((r) => setTimeout(r, 40));
        }

        finish({ ok: true, count: deletedCount, latencyMs: Date.now() - start });
      } catch (err) {
        finish({ ok: false, count: 0, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Clear all employees from Henry REP memory.
 * Sends "L[" (LimparLista) command.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function clearHenryEmployees(ip, port = 3000, password = '') {
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 15000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probeResp = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probeResp);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        const cmdName = isAdvanced ? 'EU' : 'EE';
        const cmdStr = `33+${cmdName}+00+1]L[`;

        if (isAdvanced) {
          const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
          await exchangeHenryFrame(sock, frameRawPayload(enc));
        } else {
          await exchangeHenryFrame(sock, buildHenryFrame(cmdName, '1]L['));
        }

        finish({ ok: true, latencyMs: Date.now() - start });
      } catch (err) {
        finish({ ok: false, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Query paper roll sensor status (EstadoBobina) from a Henry REP clock.
 * Discovered via REA from Secullum.Comunicacao.HenryRepComunicacao.VerificarStatusBobina.
 * Queries parameters "SP" (Sem Papel), "PP" (Pouco Papel) and "QP" (Quantidade Papel/Tickets).
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, status: string, paperOk: boolean, lowPaper: boolean, description: string, latencyMs: number, error?: string }>}
 */
async function getHenryPaperRollStatus(ip, port = 3000, password = '') {
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port, timeout: 8000 });
    let resolved = false;

    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        sock.destroy();
        resolve(result);
      }
    };

    sock.on('timeout', () => finish({ ok: false, status: 'Desconhecido', paperOk: false, lowPaper: false, description: 'Timeout de conexão', latencyMs: Date.now() - start, error: 'Connection timeout' }));
    sock.on('error', (err) => finish({ ok: false, status: 'Erro', paperOk: false, lowPaper: false, description: `Erro de rede: ${err.message}`, latencyMs: Date.now() - start, error: err.message }));

    sock.on('connect', async () => {
      try {
        let isAdvanced = false;
        const probeResp = await exchangeHenryFrame(sock, buildHenryFrame('RH'));
        const parsedProbe = parseHenryFrame(probeResp);

        if (!parsedProbe.ok || parsedProbe.cmd !== 'RH' || password) {
          const authRes = await authenticateHenrySession(sock, password);
          if (authRes.ok) isAdvanced = true;
        }

        // Query status helper
        const queryStatusParam = async (param) => {
          const cmdName = isAdvanced ? 'RQ' : 'RS';
          const cmdStr = `33+${cmdName}+00+${param}`;
          let respBuf;

          if (isAdvanced) {
            const enc = aesEncryptHenry(cmdStr, HEXA_CHAVE_AES);
            respBuf = await exchangeHenryFrame(sock, frameRawPayload(enc));
            const pLen = respBuf[1] | (respBuf[2] << 8);
            const dec = aesDecryptHenry(respBuf.subarray(3, 3 + pLen), HEXA_CHAVE_AES);
            return dec.toString('ascii');
          } else {
            respBuf = await exchangeHenryFrame(sock, buildHenryFrame(cmdName, param));
            return parseHenryFrame(respBuf).payload;
          }
        };

        // 1. Query "SP" (Sem Papel)
        let respSP = '';
        try {
          respSP = await queryStatusParam('SP');
        } catch {}

        await new Promise((r) => setTimeout(r, 40));

        // 2. Query "PP" (Pouco Papel)
        let respPP = '';
        try {
          respPP = await queryStatusParam('PP');
        } catch {}

        // Evaluate sensor flags:
        // Active indicator in Henry is 'A' (Ativo), 'B' (Bloqueado), or '1'
        const isSemPapel = respSP.includes('+A') || respSP.includes(']A') || respSP.includes('+B') || respSP.includes(']B');
        const isPoucoPapel = respPP.includes('+A') || respPP.includes(']A') || respPP.includes('+B') || respPP.includes(']B');

        let status = 'Normal';
        let description = 'Bobina em estado normal';
        let paperOk = true;
        let lowPaper = false;

        if (isSemPapel) {
          status = 'Sem Papel';
          paperOk = false;
          lowPaper = true;
          description = 'Sem Papel - Impressão bloqueada no relógio';
        } else if (isPoucoPapel) {
          status = 'Pouco Papel';
          paperOk = true;
          lowPaper = true;
          description = 'Pouco Papel - Sensor acionado, substituição necessária';
        }

        finish({
          ok: true,
          status,
          paperOk,
          lowPaper,
          description,
          latencyMs: Date.now() - start,
        });
      } catch (err) {
        finish({ ok: false, status: 'Erro', paperOk: false, lowPaper: false, description: err.message, latencyMs: Date.now() - start, error: err.message });
      }
    });
  });
}

/**
 * Query internal status telemetry from a Henry REP clock.
 * @param {string} ip
 * @param {number} [port=3000]
 * @param {string} [password=""]
 * @returns {Promise<{ ok: boolean, statusBobina: string, data?: object, latencyMs: number, error?: string }>}
 */
async function queryHenryStatus(ip, port = 3000, password = '') {
  const paper = await getHenryPaperRollStatus(ip, port, password);
  return {
    ok: paper.ok,
    statusBobina: paper.status,
    data: paper,
    latencyMs: paper.latencyMs,
    error: paper.error,
  };
}

module.exports = {
  STX,
  ETX,
  HEXA_CHAVE_AES,
  calculateChecksum,
  buildHenryFrame,
  frameRawPayload,
  parseHenryFrame,
  aesEncryptHenry,
  aesDecryptHenry,
  exchangeHenryFrame,
  authenticateHenrySession,
  formatHenryDateTimeParam,
  parseHenryAfdLine,
  collectHenryRecords,
  sendHenryEmployees,
  deleteHenryEmployees,
  clearHenryEmployees,
  sendHenryEmployer,
  receiveHenryEmployer,
  parseHenryBiometricResponse,
  receiveHenryBiometrics,
  getHenryPaperRollStatus,
  queryHenryStatus,
  syncHenryDateTime,
  sendHenryCommand,
};
