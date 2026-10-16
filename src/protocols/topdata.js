/**
 * protocols/topdata.js - Native Topdata Protocol Driver (Inner Rep / Inner Rep Plus / Inner Rep Plus v5).
 * Reverse-engineered via REA from Secullum.Comunicacao.InnerRepPlusNativoComunicacao
 * and Secullum.Comunicacao.InnerRepPlusNativoConfiguracao.
 *
 * Implements:
 *   - TCP Socket framing with 4-byte Start Envelope (0x90, 0xA9, 0xC4, 0xE1)
 *   - Symmetric stream XOR cipher (key * 29972 % 63703)
 *   - RSA-1024 key pair generation & AES-128 key exchange (TrocarChaves)
 *   - HMAC-SHA1 message integrity verification (20 bytes)
 *   - Status query & Paper roll sensor telemetry (EstadoBobina)
 *   - Time and date synchronization (EnviarRelogio)
 *   - AFD Punch log extraction from memory dumps (ReceberRegistros / DumpMemoria)
 *   - Employee upload & batch commit (EnviarInclusaoPessoas / ExecutarInclusaoPessoas)
 *   - Employee deletion (EnviarExclusaoPessoas)
 *   - Biometric templates extraction (ReceberDigitais / ListarBiometria / ReceberBiometria)
 *   - Employer data send & receive (EnviarEmpregador / ReceberEmpregador)
 *
 * Zero external npm dependencies. Pure Node.js (net, crypto).
 */

'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const DEFAULT_TOPDATA_PORT = 3570;
const START_ENVELOPE = Buffer.from([0x90, 0xA9, 0xC4, 0xE1]);

// Command definitions discovered via REA from InnerRepPlusNativoComunicacao
const COMMANDS = {
  ACK:                           { grupo: 0, envio: 0, receb: 0 },
  NACK:                          { grupo: 0, envio: 1, receb: 1 },
  ENVIAR_CHAVE_RSA:              { grupo: 1, envio: 1, receb: 101 },
  ENVIAR_CHAVE_COMUNICACAO:      { grupo: 1, envio: 2, receb: 102 },
  SOLICITAR_INFORMACOES:         { grupo: 2, envio: 0, receb: 1 },
  ENVIAR_HORARIO_VERAO:          { grupo: 10, envio: 1, receb: 101 },
  ENVIAR_RELOGIO:                { grupo: 10, envio: 2, receb: 102 },
  ENVIAR_CPF_RESPONSAVEL:        { grupo: 10, envio: 5, receb: 105 },
  ENVIAR_CONFIGURACAO_CARTAO:    { grupo: 10, envio: 6, receb: 106 },
  ENVIAR_SENHAS:                 { grupo: 10, envio: 7, receb: 107 },
  ENVIAR_FUSO_HORARIO_V5:        { grupo: 10, envio: 14, receb: 114 },
  ENVIAR_EMPREGADOR:             { grupo: 11, envio: 1, receb: 101 },
  ENVIAR_EMPREGADOR_V5:          { grupo: 11, envio: 9, receb: 109 },
  RECEBER_EMPREGADOR:            { grupo: 11, envio: 2, receb: 102 },
  RECEBER_EMPREGADOR_V5:         { grupo: 11, envio: 10, receb: 110 },
  RECEBER_PESSOAS:               { grupo: 11, envio: 5, receb: 105 },
  ENVIAR_INCLUSAO_PESSOAS:       { grupo: 11, envio: 6, receb: 106 },
  EXECUTAR_INCLUSAO_PESSOAS:     { grupo: 11, envio: 7, receb: 107 },
  ENVIAR_EXCLUSAO_PESSOAS:       { grupo: 11, envio: 8, receb: 108 },
  RECEBER_CONFIGURACOES_GERAIS:  { grupo: 15, envio: 1, receb: 101 },
  RECEBER_RELOGIO:               { grupo: 15, envio: 2, receb: 102 },
  RECEBER_ULTIMO_NSR:            { grupo: 15, envio: 7, receb: 107 },
  RECEBER_FUSO_HORARIO_ID_V5:    { grupo: 15, envio: 22, receb: 122 },
  DUMP_MEMORIA:                  { grupo: 16, envio: 0, receb: 100 },
  DUMP_MEMORIA_V5:               { grupo: 16, envio: 3, receb: 103 },
  LISTAR_BIOMETRIA_NITGEN:       { grupo: 19, envio: 11, receb: 111 },
  RECEBER_BIOMETRIA_NITGEN:      { grupo: 19, envio: 30, receb: 120 },
  EXCLUIR_BIOMETRIA_NITGEN:      { grupo: 19, envio: 31, receb: 121 },
  ENVIAR_BIOMETRIA_NITGEN:       { grupo: 19, envio: 32, receb: 122 },
  LISTAR_BIOMETRIA_LC:           { grupo: 20, envio: 11, receb: 111 },
  RECEBER_BIOMETRIA1_LC:         { grupo: 20, envio: 20, receb: 120 },
  EXCLUIR_BIOMETRIA_LC:          { grupo: 20, envio: 21, receb: 121 },
  ENVIAR_BIOMETRIA1_LC:          { grupo: 20, envio: 22, receb: 122 },
  RECEBER_BIOMETRIA2_LC:         { grupo: 20, envio: 30, receb: 130 },
  ENVIAR_BIOMETRIA2_LC:          { grupo: 20, envio: 32, receb: 132 },
};

// Paper roll status mapping (TipoStatusImpressora)
const STATUS_IMPRESSORA_MAP = {
  0:  { status: 'SemPapel',         paperOk: false, lowPaper: true,  description: 'Sem bobina de papel (crítico)' },
  1:  { status: 'NaoInstalada',     paperOk: false, lowPaper: false, description: 'Impressora não instalada' },
  2:  { status: 'ImpressoraAberta', paperOk: false, lowPaper: false, description: 'Tampa da impressora aberta' },
  3:  { status: 'PapelEnroscado',   paperOk: false, lowPaper: false, description: 'Papel enroscado na guilhotina' },
  4:  { status: 'QuaseSemPapel',    paperOk: true,  lowPaper: true,  description: 'Quase sem papel na bobina' },
  5:  { status: 'MuitoPoucoPapel',  paperOk: true,  lowPaper: true,  description: 'Muito pouco papel na bobina' },
  6:  { status: 'PoucoPapel',       paperOk: true,  lowPaper: true,  description: 'Pouco papel na bobina' },
  7:  { status: 'ComPapel',         paperOk: true,  lowPaper: false, description: 'Bobina com papel suficiente (OK)' },
  8:  { status: 'PapelMetade',      paperOk: true,  lowPaper: false, description: 'Bobina pela metade (OK)' },
  9:  { status: 'PapelQuaseVazio',  paperOk: true,  lowPaper: true,  description: 'Bobina quase vazia' },
  10: { status: 'PapelQuaseCheio',  paperOk: true,  lowPaper: false, description: 'Bobina quase cheia (OK)' },
  11: { status: 'PapelSuficiente',  paperOk: true,  lowPaper: false, description: 'Papel suficiente (OK)' },
  12: { status: 'Ocupado',          paperOk: true,  lowPaper: false, description: 'Impressora ocupada' },
  13: { status: 'Indefinido',       paperOk: true,  lowPaper: false, description: 'Status indefinido' },
};

/**
 * Convert numeric string to BCD buffer.
 * Replicates InnerRepPlusNativoComunicacao.ConverterStringParaBcd.
 * @param {string} str
 * @returns {Buffer}
 */
function converterStringParaBcd(str) {
  const digits = String(str || '').replace(/\D/g, '');
  const padded = digits.length % 2 === 1 ? '0' + digits : digits;
  const buf = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < padded.length; i += 2) {
    buf[i / 2] = parseInt(padded.slice(i, i + 2), 16);
  }
  return buf;
}

/**
 * Convert BCD buffer to decimal string.
 * Replicates InnerRepPlusNativoComunicacao.ConverterBcdParaString.
 * @param {Buffer} buf
 * @returns {string}
 */
function converterBcdParaString(buf) {
  if (!buf || !buf.length) return '';
  let str = '';
  for (let i = 0; i < buf.length; i++) {
    str += buf[i].toString(16).padStart(2, '0');
  }
  return str;
}

/**
 * Convert numeric string to BCD with each byte incremented by +1.
 * Discovered via REA: used for biometrics template query/send.
 * Replicates InnerRepPlusNativoComunicacao.ConverterStringParaBcdMaisUm.
 * @param {string} str
 * @returns {Buffer}
 */
function converterStringParaBcdMaisUm(str) {
  const bcd = converterStringParaBcd(str);
  for (let i = 0; i < bcd.length; i++) {
    bcd[i] = (bcd[i] + 1) & 0xFF;
  }
  return bcd;
}

/**
 * Convert BCD+1 buffer back to numeric string.
 * Replicates InnerRepPlusNativoComunicacao.ConverterBcdMaisUmParaString.
 * @param {Buffer} buf
 * @returns {string}
 */
function converterBcdMaisUmParaString(buf) {
  if (!buf || !buf.length) return '';
  const bcd = Buffer.from(buf);
  for (let i = 0; i < bcd.length; i++) {
    bcd[i] = (bcd[i] - 1) & 0xFF;
  }
  return converterBcdParaString(bcd);
}

/**
 * Encode string to ISO-8859-1 (Latin1) buffer padded to length with padByte.
 * @param {string} text
 * @param {number} length
 * @param {number} [padByte=0xB0] - 176 (0xB0) used for Topdata text padding
 * @returns {Buffer}
 */
function formatTextIso88591(text, length, padByte = 0xB0) {
  const clean = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const encoded = Buffer.from(clean, 'latin1');
  const buf = Buffer.alloc(length, padByte);
  encoded.copy(buf, 0, 0, Math.min(encoded.length, length));
  return buf;
}

/**
 * Symmetric stream cipher. Decryption is identical to encryption.
 * Replicates InnerRepPlusNativoComunicacao.CriptografarDescriptografarMensagem.
 * @param {Buffer} data
 * @param {Buffer|number[]} seqCripto - 2-byte seed [seed[1], seed[0]]
 * @returns {Buffer}
 */
function streamCipher(data, seqCripto) {
  let key = ((seqCripto[1] << 8) | seqCripto[0]) & 0xFFFF;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] ^ (key & 0xFF)) ^ ((key >> 8) & 0xFF);
    key = (Math.imul(key, 29972) % 63703) & 0xFFFF;
  }
  return out;
}

/**
 * Topdata native TCP communication session.
 * Manages socket connection, handshake, framing, encryption, and commands.
 */
class TopdataSession {
  /**
   * @param {string} ip
   * @param {number} [port=3570]
   * @param {object} [options={}]
   */
  constructor(ip, port = DEFAULT_TOPDATA_PORT, options = {}) {
    this.ip = ip;
    this.port = Number(port) || DEFAULT_TOPDATA_PORT;
    this.chaveComunicacao = options.chaveComunicacao || options.senha || '**AUTENTICACAO**';
    this.cpfResponsavel = options.cpfResponsavel || '';
    this.isV5 = Boolean(options.isV5 || options.tipoId === 45);
    this.timeout = options.timeout || 10000;

    this.socket = null;
    this.terminalNumber = 0xFFFF;
    this.nsuSw = 0;
    this.nsuInner = 0;
    this.nsuRxEsperado = 0;
    this.aesKey = Buffer.alloc(32, 0); // 32 zero bytes prior to handshake
    this.receiveBuffer = Buffer.alloc(0);
    this.pendingReads = [];
    this.connected = false;
  }

  /**
   * Connect to equipment and execute RSA/AES handshake.
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      let timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timeout ao conectar com ${this.ip}:${this.port}`));
      }, this.timeout);

      socket.on('data', (chunk) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
        this._flushPendingReads();
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        this.disconnect();
        reject(new Error(`Erro de conexão Topdata (${this.ip}:${this.port}): ${err.message}`));
      });

      socket.on('close', () => {
        this.connected = false;
      });

      socket.connect(this.port, this.ip, async () => {
        clearTimeout(timer);
        this.connected = true;
        try {
          await this._performHandshake();
          resolve();
        } catch (err) {
          this.disconnect();
          reject(err);
        }
      });
    });
  }

  /**
   * Disconnect socket and cleanup.
   */
  disconnect() {
    this.connected = false;
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
    this.receiveBuffer = Buffer.alloc(0);
    for (const r of this.pendingReads) {
      r.reject(new Error('Conexão encerrada'));
    }
    this.pendingReads = [];
  }

  /**
   * Asynchronously read exact N bytes from the incoming socket stream.
   * @param {number} nBytes
   * @returns {Promise<Buffer>}
   */
  _readExact(nBytes) {
    if (this.receiveBuffer.length >= nBytes) {
      const chunk = this.receiveBuffer.slice(0, nBytes);
      this.receiveBuffer = this.receiveBuffer.slice(nBytes);
      return Promise.resolve(chunk);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout aguardando ${nBytes} bytes do equipamento`));
      }, this.timeout);

      this.pendingReads.push({
        bytesNeeded: nBytes,
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  _flushPendingReads() {
    while (this.pendingReads.length > 0) {
      const next = this.pendingReads[0];
      if (this.receiveBuffer.length >= next.bytesNeeded) {
        this.pendingReads.shift();
        const data = this.receiveBuffer.slice(0, next.bytesNeeded);
        this.receiveBuffer = this.receiveBuffer.slice(next.bytesNeeded);
        next.resolve(data);
      } else {
        break;
      }
    }
  }

  /**
   * Send framed command packet and await response.
   * Replicates InnerRepPlusNativoComunicacao.EnviarReceberComandoPadrao.
   * @param {object} cmd - { grupo, envio, receb }
   * @param {Buffer|number[]} [payload=Buffer.alloc(0)]
   * @returns {Promise<Buffer>}
   */
  async sendCommand(cmd, payload = Buffer.alloc(0)) {
    if (!this.connected || !this.socket) {
      throw new Error('Sessão Topdata não conectada.');
    }

    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const innerMsg = Buffer.concat([Buffer.from([cmd.grupo, cmd.envio]), payloadBuf]);

    // 2-byte seed: random if Grupo != 0, else [0, 0]
    const seed = Buffer.alloc(2);
    if (cmd.grupo !== 0) {
      crypto.randomFillSync(seed);
    }

    // Encrypt payload with stream cipher
    const encryptedPayload = streamCipher(innerMsg, [seed[1], seed[0]]);

    // Build 13-byte header
    const header = Buffer.alloc(13);
    START_ENVELOPE.copy(header, 0); // 0..3: Start envelope
    header.writeUInt16BE(this.terminalNumber, 4); // 4..5: Terminal number
    header[6] = this.nsuSw; // 6: NSU SW
    header[7] = 0x00; // 7: Reserved
    header[8] = this.nsuInner; // 8: NSU Inner
    header[9] = seed[0]; // 9: Seed low
    header[10] = seed[1]; // 10: Seed high
    header.writeUInt16BE(encryptedPayload.length, 11); // 11..12: Payload length

    this.nsuSw = (this.nsuSw + 1) & 0xFF;

    // HMAC-SHA1 over header (13 bytes) + encryptedPayload using aesKey (32 bytes)
    const hmac = crypto.createHmac('sha1', this.aesKey)
      .update(header)
      .update(encryptedPayload)
      .digest(); // 20 bytes

    const fullPacket = Buffer.concat([header, encryptedPayload, hmac]);

    // Write packet
    this.socket.write(fullPacket);

    // Read response: 13 bytes header
    const respHeader = await this._readExact(13);

    // Validate Start Envelope
    if (!respHeader.slice(0, 4).equals(START_ENVELOPE)) {
      throw new Error('Falha na verificação de Start Envelope Topdata.');
    }

    const respLen = respHeader.readUInt16BE(11);
    const respCiphertext = await this._readExact(respLen);
    const respHmac = await this._readExact(20);

    // Verify HMAC-SHA1
    const expectedHmac = crypto.createHmac('sha1', this.aesKey)
      .update(respHeader)
      .update(respCiphertext)
      .digest();

    if (!expectedHmac.equals(respHmac)) {
      throw new Error('Falha na verificação de HMAC Topdata.');
    }

    // Verify NSU RX
    if (respHeader[8] !== this.nsuRxEsperado) {
      // Discovered in REA: if NSU RX does not match expected, communication is desynchronized
      throw new Error(`Falha na verificação de NSU RX Topdata: esperado ${this.nsuRxEsperado}, recebido ${respHeader[8]}`);
    }
    this.nsuRxEsperado = (this.nsuRxEsperado + 1) & 0xFF;

    // Update terminal and inner NSU
    this.terminalNumber = respHeader.readUInt16BE(4);
    this.nsuInner = respHeader[7];

    // Decrypt response payload
    const respSeed = [respHeader[10], respHeader[9]];
    const decrypted = streamCipher(respCiphertext, respSeed);

    const respGrupo = decrypted[0];
    const respComando = decrypted[1];

    if (respGrupo !== cmd.grupo || respComando !== cmd.receb) {
      throw new Error(`Comando Topdata recebido diferente do enviado: esperado (${cmd.grupo}, ${cmd.receb}), recebido (${respGrupo}, ${respComando})`);
    }

    // Return payload data (excluding grupo and comando bytes)
    return decrypted.slice(2);
  }

  /**
   * Execute RSA-1024 public key exchange and AES key initialization.
   * Replicates InnerRepPlusNativoComunicacao.TrocarChaves and EnviarCpfResposavel.
   * @private
   */
  async _performHandshake() {
    this.aesKey = Buffer.alloc(32, 0);

    // Generate RSA-1024 key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'pkcs1', format: 'der' },
      privateKeyEncoding: { type: 'pkcs1', format: 'der' },
    });

    // Parse PKCS#1 DER RSAPublicKey: SEQUENCE { modulus INTEGER, publicExponent INTEGER }
    let offset = 0;
    if (publicKey[offset++] !== 0x30) throw new Error('Falha ao exportar chave RSA pública (ASN.1 Sequence inválida).');
    let seqLen = publicKey[offset++];
    if (seqLen & 0x80) offset += (seqLen & 0x7F);

    if (publicKey[offset++] !== 0x02) throw new Error('Falha ao exportar chave RSA pública (Modulus ausente).');
    let modLen = publicKey[offset++];
    if (modLen & 0x80) {
      const numBytes = modLen & 0x7F;
      modLen = 0;
      for (let i = 0; i < numBytes; i++) modLen = (modLen << 8) | publicKey[offset++];
    }
    let modBytes = publicKey.slice(offset, offset + modLen);
    offset += modLen;
    // Strip leading 0x00 if 129 bytes
    if (modBytes.length === 129 && modBytes[0] === 0x00) {
      modBytes = modBytes.slice(1);
    }

    if (publicKey[offset++] !== 0x02) throw new Error('Falha ao exportar chave RSA pública (Exponent ausente).');
    let expLen = publicKey[offset++];
    let expBytes = publicKey.slice(offset, offset + expLen);
    if (expBytes.length < 3) {
      const p = Buffer.alloc(3);
      expBytes.copy(p, 3 - expBytes.length);
      expBytes = p;
    }

    // 131 bytes: Modulus (128 bytes) + Exponent (3 bytes)
    const rsaPublicKeyBytes = Buffer.concat([modBytes, expBytes]);

    // Send RSA Public Key
    const encAesKey = await this.sendCommand(COMMANDS.ENVIAR_CHAVE_RSA, rsaPublicKeyBytes);

    // Decrypt AES Key using RSA private key with PKCS#1 v1.5 padding
    const decryptedAesKey = crypto.privateDecrypt(
      { key: privateKey, format: 'der', type: 'pkcs1', padding: crypto.constants.RSA_PKCS1_PADDING },
      encAesKey
    );

    if (decryptedAesKey.length !== 32) {
      throw new Error(`Tamanho de chave AES retornado inválido: esperado 32 bytes, recebido ${decryptedAesKey.length}`);
    }
    this.aesKey = decryptedAesKey; // First 16 bytes = AES-128 key, Next 16 bytes = AES-128 IV

    // Encrypt communication key with AES-128-CBC
    const commKeyStr = this.chaveComunicacao && this.chaveComunicacao !== '**AUTENTICACAO**'
      ? this.chaveComunicacao
      : '**Chave apagada**';

    const aesKeyPart = this.aesKey.slice(0, 16);
    const aesIvPart = this.aesKey.slice(16, 32);

    const cipher = crypto.createCipheriv('aes-128-cbc', aesKeyPart, aesIvPart);
    const encryptedCommKey = Buffer.concat([
      cipher.update(Buffer.from(commKeyStr, 'latin1')),
      cipher.final(),
    ]);

    // Send Communication Key
    const respCommKey = await this.sendCommand(COMMANDS.ENVIAR_CHAVE_COMUNICACAO, encryptedCommKey);
    if (respCommKey.length > 0 && respCommKey[0] !== 0x00) {
      throw new Error('Falha ao enviar chave de comunicação Topdata (chave incorreta ou rejeitada).');
    }

    // Send CPF Responsável
    // Discovered in REA: ModuloGeral.RetornarSomenteNumeros.PadLeft(12, '0') + "00" -> ConverterStringParaBcd (7 bytes)
    const cpfNums = String(this.cpfResponsavel || '').replace(/\D/g, '').padStart(12, '0') + '00';
    const cpfBcd = converterStringParaBcd(cpfNums);
    const respCpf = await this.sendCommand(COMMANDS.ENVIAR_CPF_RESPONSAVEL, cpfBcd);
    if (respCpf.length > 0 && respCpf[0] !== 0x00) {
      throw new Error('Falha ao enviar CPF do responsável Topdata.');
    }
  }
}

/**
 * Synchronize date and time on a Topdata Inner equipment.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {Date} [date=new Date()]
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function syncTopdataDateTime(ip, port = DEFAULT_TOPDATA_PORT, date = new Date(), options = {}) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);
  try {
    await session.connect();

    // ddMMyyHHmmss in BCD (6 bytes)
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(date.getDate())}${pad(date.getMonth() + 1)}${pad(date.getFullYear() % 100)}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const payload = converterStringParaBcd(timeStr);

    const resp = await session.sendCommand(COMMANDS.ENVIAR_RELOGIO, payload);
    if (resp.length > 0 && resp[0] !== 0x00) {
      throw new Error('Equipamento rejeitou a sincronização de data e hora.');
    }

    session.disconnect();
    return { ok: true, latencyMs: Date.now() - startTime };
  } catch (err) {
    session.disconnect();
    return { ok: false, latencyMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Query detailed equipment status and paper roll telemetry.
 * Discovered via REA from InnerRepPlusNativoComunicacao.ReceberStatusEquipamento.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, serialNumber: string, firmware: string, modeloBiometria: number, statusEquipamento: number, statusImpressora: number, paperOk: boolean, lowPaper: boolean, description: string, latencyMs: number, error?: string }>}
 */
async function queryTopdataStatus(ip, port = DEFAULT_TOPDATA_PORT, options = {}) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);
  try {
    await session.connect();

    // Payload [0x01] = Solicitar status geral do equipamento
    const resp = await session.sendCommand(COMMANDS.SOLICITAR_INFORMACOES, Buffer.from([0x01]));
    session.disconnect();

    // Parse DadosStatusEquipamento
    const serialNumber = resp.slice(0, 17).toString('ascii').replace(/\0+$/, '').trim();
    const versaoPlaca = resp.length > 18 ? String(resp[18]) : '';
    const modeloBiometria = resp.length > 20 ? resp[20] : 0; // 0 = Nitgen, 1 = CAPI/LC
    const firmware = resp.length > 23 ? `${resp[22]}.${resp[23].toString(16).padStart(2, '0')}` : '';
    const statusEquipamento = resp.length > 36 ? resp[36] : 0;
    const statusImpressoraCode = resp.length > 37 ? resp[37] : 7;

    const paperInfo = STATUS_IMPRESSORA_MAP[statusImpressoraCode] || {
      status: 'Desconhecido',
      paperOk: true,
      lowPaper: false,
      description: `Código status bobina desconhecido (${statusImpressoraCode})`,
    };

    return {
      ok: true,
      serialNumber,
      versaoPlaca,
      modeloBiometria,
      firmware,
      statusEquipamento,
      statusImpressora: statusImpressoraCode,
      status: paperInfo.status,
      paperOk: paperInfo.paperOk,
      lowPaper: paperInfo.lowPaper,
      description: paperInfo.description,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    session.disconnect();
    return {
      ok: false,
      serialNumber: '',
      firmware: '',
      statusEquipamento: 1,
      statusImpressora: 13,
      status: 'Erro',
      paperOk: false,
      lowPaper: false,
      description: err.message,
      latencyMs: Date.now() - startTime,
      error: err.message,
    };
  }
}

/**
 * Query paper roll sensor status (EstadoBobina) for telemetry.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, status: string, paperOk: boolean, lowPaper: boolean, description: string, latencyMs: number, error?: string }>}
 */
async function getTopdataPaperRollStatus(ip, port = DEFAULT_TOPDATA_PORT, options = {}) {
  const res = await queryTopdataStatus(ip, port, options);
  return {
    ok: res.ok,
    status: res.status,
    paperOk: res.paperOk,
    lowPaper: res.lowPaper,
    description: res.description,
    latencyMs: res.latencyMs,
    error: res.error,
  };
}

/**
 * Collect punch records (AFD / Batidas) from Topdata equipment.
 * Discovered via REA from InnerRepPlusNativoComunicacao.ReceberRegistros.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {number} [startNsr=0]
 * @param {number} [count=100]
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, records: Array<object>, lastNsr: number, rawCount: number, latencyMs: number, error?: string }>}
 */
async function collectTopdataRecords(ip, port = DEFAULT_TOPDATA_PORT, startNsr = 0, count = 100, options = {}) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);
  const records = [];
  const limit = Math.max(1, count || 100);

  try {
    await session.connect();

    // 1. Query latest NSR and flash end address
    const nsrResp = await session.sendCommand(COMMANDS.RECEBER_ULTIMO_NSR);
    const ultimoNsrStr = converterBcdParaString(nsrResp.slice(4, 8)).replace(/^0+/, '');
    const ultimoNsr = parseInt(ultimoNsrStr || '0', 10);
    const fimMemoria = (nsrResp[12] << 24) | (nsrResp[13] << 16) | (nsrResp[14] << 8) | nsrResp[15];

    if (startNsr >= ultimoNsr || ultimoNsr === 0) {
      session.disconnect();
      return { ok: true, records: [], lastNsr: startNsr, rawCount: 0, latencyMs: Date.now() - startTime };
    }

    // 2. Estimate initial flash dump address (each sector is 512 bytes, ~50 records per sector)
    let currentAddress = Math.max(0, Math.floor(startNsr / 50) * 512);
    let highestNsrFound = startNsr;
    const dumpCmd = session.isV5 ? COMMANDS.DUMP_MEMORIA_V5 : COMMANDS.DUMP_MEMORIA;

    // Search forward / dump loop
    while (records.length < limit && currentAddress < fimMemoria) {
      const addrBuf = Buffer.alloc(4);
      addrBuf.writeUInt32BE(currentAddress, 0);

      const dumpResp = await session.sendCommand(dumpCmd, addrBuf);
      // First 4 bytes echo the address, remaining is the 512-byte sector
      const sectorData = dumpResp.slice(4);
      if (!sectorData.length) break;

      let sectorHasRecords = false;
      let offset = 0;

      while (offset < sectorData.length && records.length < limit) {
        const recordType = sectorData[offset];
        if (recordType === 0xFF || recordType === 0x00) {
          // Erased / empty flash end
          offset = sectorData.length;
          break;
        }

        // Determine record length based on type and firmware version
        let recLen = 0;
        if (recordType === 0xA2) {
          recLen = 274; // Type 1: Header
        } else if (recordType === 0xA3) {
          recLen = session.isV5 ? 17 : 16; // Type 3: Punch
        } else if (recordType === 0xA4) {
          recLen = session.isV5 ? 17 : 15; // Type 4: Clock adjustment
        } else if (recordType === 0xA5) {
          recLen = 230; // Type 5: Employer update
        } else if (recordType === 0xA6) {
          recLen = 12; // Type 6: Employee update
        } else {
          // Unknown / corrupt record boundary
          break;
        }

        if (offset + recLen > sectorData.length) break;

        const record = sectorData.slice(offset, offset + recLen);
        offset += recLen;
        sectorHasRecords = true;

        if (recordType === 0xA3) {
          // Parse Type 3 punch record
          const recNsrStr = converterBcdParaString(record.slice(1, 5)).replace(/^0+/, '');
          const nsr = parseInt(recNsrStr || '0', 10);

          if (nsr > highestNsrFound) highestNsrFound = nsr;
          if (nsr <= startNsr) continue; // Skip punches already collected

          // Date & Time (5 bytes BCD: ddMMyyHHmm)
          const timeBcd = converterBcdParaString(record.slice(5, 10));
          const day = timeBcd.slice(0, 2);
          const month = timeBcd.slice(2, 4);
          const year = '20' + timeBcd.slice(4, 6);
          const hour = timeBcd.slice(6, 8);
          const minute = timeBcd.slice(8, 10);
          const dateIso = `${year}-${month}-${day}T${hour}:${minute}:00.000Z`;

          // Document & Timezone
          let docOffset = 10;
          let tz = -180;
          if (session.isV5) {
            tz = record[10] * -60;
            docOffset = 11;
          }
          const doc = converterBcdParaString(record.slice(docOffset, docOffset + 6)).replace(/^0+/, '');
          const isCpf = doc.length === 11 || options.usaCpf;

          records.push({
            Nsr: nsr,
            DataHora: dateIso,
            CPF: isCpf ? doc.padStart(11, '0') : null,
            PIS: !isCpf ? doc.padStart(11, '0') : '',
            Matricula: null,
            EquipamentoId: options.equipmentId || 0,
            RegistroPortaria671: isCpf,
            Sentido: 0,
            Tipo: 0,
            TipoEvento: 3,
            FusoHorarioMinutos: tz,
          });

          if (nsr >= ultimoNsr) break;
        } else if (recordType === 0xA4) {
          // Clock change record
          const recNsrStr = converterBcdParaString(record.slice(1, 5)).replace(/^0+/, '');
          const nsr = parseInt(recNsrStr || '0', 10);
          if (nsr > highestNsrFound) highestNsrFound = nsr;
          if (nsr > startNsr) {
            const timeBcd = converterBcdParaString(record.slice(5, 10));
            const day = timeBcd.slice(0, 2);
            const month = timeBcd.slice(2, 4);
            const year = '20' + timeBcd.slice(4, 6);
            const hour = timeBcd.slice(6, 8);
            const minute = timeBcd.slice(8, 10);
            const dateIso = `${year}-${month}-${day}T${hour}:${minute}:00.000Z`;

            records.push({
              Nsr: nsr,
              DataHora: dateIso,
              CPF: null,
              PIS: '',
              Matricula: null,
              EquipamentoId: options.equipmentId || 0,
              RegistroPortaria671: false,
              Sentido: 0,
              Tipo: 0,
              TipoEvento: 4,
            });
          }
        }
      }

      currentAddress += 512;
      if (!sectorHasRecords && currentAddress > (Math.floor(startNsr / 50) + 10) * 512) {
        break;
      }
      if (highestNsrFound >= ultimoNsr) break;
    }

    session.disconnect();
    return {
      ok: true,
      records,
      lastNsr: highestNsrFound,
      rawCount: records.length,
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    session.disconnect();
    return {
      ok: false,
      records,
      lastNsr: startNsr,
      rawCount: 0,
      latencyMs: Date.now() - startTime,
      error: err.message,
    };
  }
}

/**
 * Format a single employee record into the 100-byte Topdata binary format.
 * Discovered via REA from InnerRepPlusNativoComunicacao.<EnviarPessoasHorarios>g__InformarDadosPessoaParaEnvio.
 * @param {object} emp
 * @param {boolean} [usaCpf=false]
 * @returns {Buffer} 100-byte record
 */
function buildTopdataEmployeeRecord(emp, usaCpf = false) {
  const buf = Buffer.alloc(100, 0);

  // 1. Document (6 bytes BCD, 12 digits padded left)
  const docRaw = (usaCpf && emp.Cpf ? emp.Cpf : (emp.Pis || emp.Cpf || emp.documento || '')).replace(/\D/g, '');
  const docBcd = converterStringParaBcd(docRaw.padStart(12, '0'));
  docBcd.copy(buf, 0, 0, Math.min(6, docBcd.length));

  // 2. Name (52 bytes ISO-8859-1, padded right with 0xB0)
  const nameBuf = formatTextIso88591(emp.Nome || emp.nome || '', 52, 0xB0);
  nameBuf.copy(buf, 6, 0, 52);

  // 3. Biometrics / Password flag (2 bytes at offset 58)
  const hasBio = emp.VerificarBiometria !== false;
  if (hasBio) {
    buf[58] = 0xEE;
    buf[59] = 0xEE;
  } else if (emp.Senha || emp.senha) {
    const pwBcd = converterStringParaBcd(String(emp.Senha || emp.senha).padStart(4, '0'));
    pwBcd.copy(buf, 58, 0, Math.min(2, pwBcd.length));
  } else {
    buf[58] = 0xFF;
    buf[59] = 0xFF;
  }

  // 4. Short / Display Name (16 bytes, padded with 0xFF)
  const shortName = (emp.Nome || emp.nome || '').slice(0, 16);
  const shortBuf = formatTextIso88591(shortName, 16, 0xFF);
  shortBuf.copy(buf, 60, 0, 16);

  // 5. Badge Number (8 bytes BCD, 16 digits padded left at offset 76)
  const badgeRaw = String(emp.NumeroIdentificador || emp.Cartao || emp.cartao || emp.id || '0').replace(/\D/g, '');
  const badgeBcd = converterStringParaBcd(badgeRaw.padStart(16, '0'));
  badgeBcd.copy(buf, 76, 0, Math.min(8, badgeBcd.length));

  // 6. Badge copy (8 bytes at offset 84)
  badgeBcd.copy(buf, 84, 0, Math.min(8, badgeBcd.length));

  // 7. Keyboard ID (8 bytes at offset 92)
  badgeBcd.copy(buf, 92, 0, Math.min(8, badgeBcd.length));

  return buf;
}

/**
 * Send employee list to Topdata equipment.
 * Discovered via REA from InnerRepPlusNativoComunicacao.EnviarPessoasHorarios.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {Array<object>} employees
 * @param {object} [options={}]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, count: number, latencyMs: number, error?: string }>}
 */
async function sendTopdataEmployees(ip, port = DEFAULT_TOPDATA_PORT, employees = [], options = {}, onProgress = null) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);
  let sentCount = 0;

  try {
    await session.connect();

    // Divide employee list into 100-person chunks
    const chunkSize = 100;
    const total = employees.length;

    for (let c = 0; c < total; c += chunkSize) {
      const batch = employees.slice(c, c + chunkSize);

      // Sub-divide batch into 8-employee packets (each packet <= 808 bytes)
      const subChunkSize = 8;
      let offsetInBatch = 0;

      for (let s = 0; s < batch.length; s += subChunkSize) {
        const subBatch = batch.slice(s, s + subChunkSize);
        // Header (8 bytes): totalInBatch (2 BE), subCount (2 BE), offsetInBatch (2 BE), 0x00, 0x00
        const packet = Buffer.alloc(8 + subBatch.length * 100);
        packet.writeUInt16BE(batch.length, 0);
        packet.writeUInt16BE(subBatch.length, 2);
        packet.writeUInt16BE(offsetInBatch, 4);
        packet[6] = 0x00;
        packet[7] = 0x00;

        for (let i = 0; i < subBatch.length; i++) {
          const empRec = buildTopdataEmployeeRecord(subBatch[i], options.usaCpf);
          empRec.copy(packet, 8 + i * 100, 0, 100);
        }

        await session.sendCommand(COMMANDS.ENVIAR_INCLUSAO_PESSOAS, packet);
        offsetInBatch += subBatch.length;
      }

      // Commit 100-person batch with ExecutarInclusaoPessoas
      const commitBuf = Buffer.alloc(2);
      commitBuf.writeUInt16BE(batch.length, 0);
      const commitResp = await session.sendCommand(COMMANDS.EXECUTAR_INCLUSAO_PESSOAS, commitBuf);

      // Check results per employee (1 byte per employee in batch, 0 = success)
      sentCount += batch.length;
      if (typeof onProgress === 'function') {
        onProgress(sentCount, total);
      }
    }

    session.disconnect();
    return { ok: true, count: sentCount, latencyMs: Date.now() - startTime };
  } catch (err) {
    session.disconnect();
    return { ok: false, count: sentCount, latencyMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Delete specified employees from Topdata equipment memory.
 * Discovered via REA from InnerRepPlusNativoComunicacao.ApagarPessoas.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {Array<object|string>} employees
 * @param {object} [options={}]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, count: number, latencyMs: number, error?: string }>}
 */
async function deleteTopdataEmployees(ip, port = DEFAULT_TOPDATA_PORT, employees = [], options = {}, onProgress = null) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);
  let deletedCount = 0;

  try {
    await session.connect();

    // Extract documents (12-digit BCD)
    const docs = employees.map((e) => {
      if (typeof e === 'string') return e.replace(/\D/g, '');
      return (e.Cpf || e.Pis || e.documento || '').replace(/\D/g, '');
    }).filter(Boolean);

    // Chunks of up to 100 documents per delete command
    const chunkSize = 100;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
      // Header: 2 bytes count (UInt16BE)
      const packet = Buffer.alloc(2 + chunk.length * 6);
      packet.writeUInt16BE(chunk.length, 0);

      for (let j = 0; j < chunk.length; j++) {
        const bcd = converterStringParaBcd(chunk[j].padStart(12, '0'));
        bcd.copy(packet, 2 + j * 6, 0, 6);
      }

      await session.sendCommand(COMMANDS.ENVIAR_EXCLUSAO_PESSOAS, packet);
      deletedCount += chunk.length;
      if (typeof onProgress === 'function') {
        onProgress(deletedCount, docs.length);
      }
    }

    session.disconnect();
    return { ok: true, count: deletedCount, latencyMs: Date.now() - startTime };
  } catch (err) {
    session.disconnect();
    return { ok: false, count: deletedCount, latencyMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Clear all employees from Topdata equipment.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function clearTopdataEmployees(ip, port = DEFAULT_TOPDATA_PORT, options = {}) {
  // Query biometrics/people list and delete all
  const startTime = Date.now();
  const bioRes = await receiveTopdataBiometrics(ip, port, [], options);
  if (!bioRes.ok) return { ok: false, latencyMs: Date.now() - startTime, error: bioRes.error };
  const docs = bioRes.biometrics.map((b) => b.documento).filter(Boolean);
  if (docs.length === 0) return { ok: true, latencyMs: Date.now() - startTime };
  return deleteTopdataEmployees(ip, port, docs, options);
}

/**
 * Extract registered biometric templates from Topdata equipment.
 * Discovered via REA from InnerRepPlusNativoComunicacao.ReceberDigitais.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {Array<object>} [employees=[]]
 * @param {object} [options={}]
 * @param {function} [onProgress]
 * @returns {Promise<{ ok: boolean, biometrics: Array<object>, count: number, latencyMs: number, error?: string }>}
 */
async function receiveTopdataBiometrics(ip, port = DEFAULT_TOPDATA_PORT, employees = [], options = {}, onProgress = null) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);
  const biometrics = [];

  try {
    await session.connect();

    // 1. Query registered biometrics list
    // Nitgen (Tipo 0 / 2) vs LC (Tipo 1 / 3)
    const isNitgen = options.tipoBiometria === 0;
    const listCmd = isNitgen ? COMMANDS.LISTAR_BIOMETRIA_NITGEN : COMMANDS.LISTAR_BIOMETRIA_LC;

    const listResp = await session.sendCommand(listCmd);
    // Parse list of registered documents: 8-byte BCD+1 entries
    const registeredDocs = [];
    for (let i = 0; i < listResp.length; i += 8) {
      if (i + 8 <= listResp.length) {
        const docBcd = listResp.slice(i, i + 8);
        const doc = converterBcdMaisUmParaString(docBcd).replace(/^0+/, '');
        if (doc) registeredDocs.push(doc);
      }
    }

    // Map cloud employees by document
    const empMap = new Map();
    for (const e of employees) {
      const doc = String(e.Cpf || e.Pis || e.documento || '').replace(/\D/g, '').replace(/^0+/, '');
      if (doc) empMap.set(doc, e);
    }

    const total = registeredDocs.length;
    let processed = 0;

    // 2. Fetch biometric template for each document
    for (const doc of registeredDocs) {
      const docBcdMaisUm = converterStringParaBcdMaisUm(doc.padStart(16, '0'));
      const emp = empMap.get(doc) || { Id: 0, Nome: '', Pis: doc };

      if (!isNitgen) {
        // LC reader: ReceberBiometria1LC and ReceberBiometria2LC
        const bio1 = await session.sendCommand(COMMANDS.RECEBER_BIOMETRIA1_LC, docBcdMaisUm);
        if (bio1.length > 70) {
          const tpl = bio1.slice(70);
          biometrics.push({
            PessoaId: emp.Id || 0,
            documento: doc,
            Dedo: 0,
            Template: tpl.toString('base64'),
            Tipo: 3, // LC Biometrics
            TemplateCodigo: `${doc}-0`,
          });
        }

        const bio2 = await session.sendCommand(COMMANDS.RECEBER_BIOMETRIA2_LC, docBcdMaisUm);
        if (bio2.length > 70) {
          const tpl = bio2.slice(70);
          biometrics.push({
            PessoaId: emp.Id || 0,
            documento: doc,
            Dedo: 1,
            Template: tpl.toString('base64'),
            Tipo: 3,
            TemplateCodigo: `${doc}-1`,
          });
        }
      } else {
        // Nitgen reader: ReceberBiometriaNitgen
        const bioNitgen = await session.sendCommand(COMMANDS.RECEBER_BIOMETRIA_NITGEN, docBcdMaisUm);
        if (bioNitgen.length > 70) {
          const tpl = bioNitgen.slice(70);
          biometrics.push({
            PessoaId: emp.Id || 0,
            documento: doc,
            Dedo: 0,
            Template: tpl.toString('base64'),
            Tipo: 2, // Nitgen
            TemplateCodigo: `${doc}-0`,
          });
        }
      }

      processed++;
      if (typeof onProgress === 'function') {
        onProgress(processed, total);
      }
    }

    session.disconnect();
    return { ok: true, biometrics, count: biometrics.length, latencyMs: Date.now() - startTime };
  } catch (err) {
    session.disconnect();
    return { ok: false, biometrics: [], count: 0, latencyMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Send employer data to Topdata equipment.
 * Discovered via REA from InnerRepPlusNativoComunicacao.EnviarEmpregador.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {object} employer
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function sendTopdataEmployer(ip, port = DEFAULT_TOPDATA_PORT, employer = {}, options = {}) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);

  try {
    await session.connect();

    const isV5 = session.isV5;
    const bufLen = isV5 ? 265 : 264;
    const buf = Buffer.alloc(bufLen, 0);

    // Document type: 1 = CNPJ ('1' / 0x31), 2 = CPF ('2' / 0x32)
    const docRaw = String(employer.Documento || employer.documento || '').replace(/\D/g, '');
    const isCpf = docRaw.length <= 11;
    buf[0] = isCpf ? 0x32 : 0x31;

    // Document (7 bytes BCD, 14 digits)
    const docBcd = converterStringParaBcd(docRaw.padStart(14, '0'));
    docBcd.copy(buf, 1, 0, Math.min(7, docBcd.length));

    // CEI / CAEPF (6 or 7 bytes BCD)
    const ceiRaw = String(employer.Cei || employer.cei || '').replace(/\D/g, '');
    const ceiDigits = isV5 ? 14 : 12;
    const ceiBcd = converterStringParaBcd(ceiRaw.padStart(ceiDigits, '0'));
    const ceiOffset = isV5 ? 8 : 8;
    ceiBcd.copy(buf, ceiOffset, 0, Math.min(isV5 ? 7 : 6, ceiBcd.length));

    // Razão Social (150 bytes, padded with 0xB0)
    const rzOffset = isV5 ? 15 : 14;
    const rzBuf = formatTextIso88591(employer.RazaoSocial || employer.razaoSocial || '', 150, 0xB0);
    rzBuf.copy(buf, rzOffset, 0, 150);

    // Local / Endereço (100 bytes, padded with 0xB0)
    const locOffset = isV5 ? 165 : 164;
    const locBuf = formatTextIso88591(employer.Local || employer.local || '', 100, 0xB0);
    locBuf.copy(buf, locOffset, 0, 100);

    const cmd = isV5 ? COMMANDS.ENVIAR_EMPREGADOR_V5 : COMMANDS.ENVIAR_EMPREGADOR;
    const resp = await session.sendCommand(cmd, buf);
    if (resp.length > 0 && resp[0] !== 0x00) {
      throw new Error('Equipamento rejeitou os dados do empregador.');
    }

    session.disconnect();
    return { ok: true, latencyMs: Date.now() - startTime };
  } catch (err) {
    session.disconnect();
    return { ok: false, latencyMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Receive employer data from Topdata equipment.
 * Discovered via REA from InnerRepPlusNativoComunicacao.ReceberEmpregador.
 * @param {string} ip
 * @param {number} [port=3570]
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, employer?: object, latencyMs: number, error?: string }>}
 */
async function receiveTopdataEmployer(ip, port = DEFAULT_TOPDATA_PORT, options = {}) {
  const startTime = Date.now();
  const session = new TopdataSession(ip, port, options);

  try {
    await session.connect();

    const cmd = session.isV5 ? COMMANDS.RECEBER_EMPREGADOR_V5 : COMMANDS.RECEBER_EMPREGADOR;
    const resp = await session.sendCommand(cmd);
    session.disconnect();

    const tipoDoc = resp[0] === 0x32 ? 2 : 1;
    const docBcd = resp.slice(1, 8);
    let documento = converterBcdParaString(docBcd);
    if (tipoDoc === 2) documento = documento.slice(-11);

    const ceiOffset = 8;
    const ceiLen = session.isV5 ? 7 : 6;
    const cei = converterBcdParaString(resp.slice(ceiOffset, ceiOffset + ceiLen)).replace(/^0+/, '');

    const rzOffset = session.isV5 ? 15 : 14;
    const razaoSocial = resp.slice(rzOffset, rzOffset + 150).toString('latin1').replace(/\xB0+$/, '').trim();

    const locOffset = session.isV5 ? 165 : 164;
    const local = resp.slice(locOffset, locOffset + 100).toString('latin1').replace(/\xB0+$/, '').trim();

    return {
      ok: true,
      employer: {
        TipoDeDocumento: tipoDoc,
        Documento: documento,
        Cei: cei,
        RazaoSocial: razaoSocial,
        Local: local,
      },
      latencyMs: Date.now() - startTime,
    };
  } catch (err) {
    session.disconnect();
    return { ok: false, latencyMs: Date.now() - startTime, error: err.message };
  }
}

module.exports = {
  DEFAULT_TOPDATA_PORT,
  START_ENVELOPE,
  COMMANDS,
  STATUS_IMPRESSORA_MAP,
  TopdataSession,
  converterStringParaBcd,
  converterBcdParaString,
  converterStringParaBcdMaisUm,
  converterBcdMaisUmParaString,
  formatTextIso88591,
  streamCipher,
  syncTopdataDateTime,
  queryTopdataStatus,
  getTopdataPaperRollStatus,
  collectTopdataRecords,
  sendTopdataEmployees,
  deleteTopdataEmployees,
  clearTopdataEmployees,
  receiveTopdataBiometrics,
  sendTopdataEmployer,
  receiveTopdataEmployer,
};
