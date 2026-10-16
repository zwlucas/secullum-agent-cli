/**
 * cloud/realtime.js - Standalone RealTime WebSocket client for Secullum Cloud.
 * Connects directly to wss://pontowebcomunicacao.secullum.com.br/
 * Discovered via REA from Secullum.RealTime.Client.dll & Secullum.RealTime.Core.dll:
 *   - Protocol Version: 1
 *   - Authentication: Raw JSON text frame { AccessToken, Group, ProtocolVersion: 1, Headers: {} }
 *   - Auth Response:  { ResponseAuth: "ok" } or { ResponseAuth: "invalid_token" | ... }
 *   - Hub Dispatch:   { HubName: "Comunicacao", MethodName: "EstabelecerConexaoAgente", Arguments: [...] }
 *   - Heartbeat:      Server sends { HubName: "--PING--" } -> Client responds { HubName: "--PONG--" }
 *   - Cloud Events:   Server sends { HubName: "Comunicacao", EventName: "...", Arguments: [...] }
 * Zero external npm dependencies (uses native Node.js globalThis.WebSocket & EventEmitter).
 */

'use strict';

const EventEmitter = require('node:events');
const os = require('node:os');
const { getValidAccessToken } = require('./auth');
const { loadSession } = require('./session');

const DEFAULT_REALTIME_URL = 'wss://pontowebcomunicacao.secullum.com.br/';
const AGENT_VERSION = '1.54.0.0';
const PROTOCOL_VERSION = 19;

/**
 * Secullum.Comunicacao.TipoTarefa enum values (decompiled via REA).
 */
const TipoTarefa = Object.freeze({
  EnviarConfiguracoes: 0,
  EnviarDataHora: 1,
  EnviarListaPessoas: 2,
  EnviarAutomaticoPessoas: 3,
  EnviarAutomaticoHorarios: 4,
  ReceberConfiguracoes: 5,
  ReceberDataHora: 6,
  ReceberListaPessoas: 7,
  ReceberRegistros: 8,
  ListarPessoas: 9,
  ApagarPessoas: 10,
  CapturarDigital: 11,
  EnvioAgendadoDataHora: 12,
  EnvioAgendadoPessoas: 13,
  RecebimentoAgendadoRegistros: 14,
  EnvioAutomaticoBiometrias: 15,
  ReceberEmpregador: 16,
  EnviarEmpregador: 17,
  RecebimentoAgendadoPessoas: 18,
  EnvioAutomaticoDados: 19,
  DesbloquearEquipamento: 20,
  ExportarFuncionariosRB1: 21,
  ImportarFuncionariosRB1: 22,
  AgenteConectado: 23,
  AgenteDesconectado: 24,
  AgenteReconectado: 25,
  ReceberRegistrosTabelaTemporaria: 26,
  RecebimentoAutomaticoRegistros: 27,
  ReceberDigitais: 28,
  DownloadLogEventos: 29,
  InclusaoRegistrosTabelaTemporaria: 30,
  ExportarFuncionariosRB2: 31,
  ImportarFuncionariosRB2: 32,
  RecebimentoAutomaticoFotosRegistros: 33,
  RecebimentoAgendadoBiometrias: 34,
  SolicitandoFotosPendentesRegistros: 35,
  ConversaoBiometriaFacial: 36,
});

/**
 * Retrieve primary physical MAC address of the active network interface.
 * Formats as colon-separated or dash-separated hex (similar to .NET NetworkInterface.GetPhysicalAddress).
 * @returns {string}
 */
function getPrimaryMacAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name] || []) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          return net.mac.toUpperCase();
        }
      }
    }
  } catch {}
  return '00:00:00:00:00:00';
}

class RealTimeGateway extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.url] - WebSocket URL
   * @param {string} [options.accessToken] - OAuth token (optional, auto-loaded)
   * @param {string} [options.bancoId] - Database GUID (Group)
   * @param {Array<object>} [options.equipments] - Equipment list to register
   * @param {Record<string|number, boolean>} [options.statusEquipamentos] - Initial equipment connection map
   * @param {Record<string|number, string>} [options.statusBobina] - Initial paper roll sensor map
   * @param {string} [options.instancia=''] - Service instance name
   * @param {boolean} [options.autoReconnect=true] - Reconnect automatically on disconnect
   * @param {number} [options.reconnectDelay=5000] - Delay in ms before reconnect
   */
  constructor(options = {}) {
    super();
    this.url = options.url || DEFAULT_REALTIME_URL;
    this.accessToken = options.accessToken || null;
    this.bancoId = options.bancoId || null;
    this.equipments = options.equipments || [];
    this.statusEquipamentos = options.statusEquipamentos || {};
    this.statusBobina = options.statusBobina || {};
    this.instancia = options.instancia || '';
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectDelay = options.reconnectDelay || 5000;

    this.ws = null;
    this.isAuthenticated = false;
    this.isRegistered = false;
    this.shouldStop = false;
    this.reconnectTimer = null;
  }

  /**
   * Connect to the Secullum RealTime WebSocket gateway.
   * @returns {Promise<void>}
   */
  async connect() {
    this.shouldStop = false;

    // Resolve credentials if not provided
    if (!this.accessToken) {
      this.accessToken = await getValidAccessToken();
    }

    if (!this.bancoId) {
      const session = loadSession();
      this.bancoId = session?.bancoSelecionado?.Identificador || session?.bancoId;
      if (!this.bancoId) {
        throw new Error('No company database selected. Run: secullum-agent-cli databases');
      }
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      try {
        this.emit('connecting', { url: this.url, bancoId: this.bancoId });
        this.ws = new WebSocket(this.url);
      } catch (err) {
        return reject(err);
      }

      this.ws.onopen = () => {
        this.emit('connected', { url: this.url });
        // Immediately send Authentication handshake frame
        this._sendAuthHandshake();
      };

      this.ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString('utf-8');
          const msg = JSON.parse(raw);
          this._handleIncomingMessage(msg, (err) => {
            if (!resolved) {
              resolved = true;
              if (err) reject(err);
              else resolve();
            }
          });
        } catch (err) {
          this.emit('parse_error', { error: err.message, raw: event.data });
        }
      };

      this.ws.onerror = (event) => {
        const error = event.error || new Error(event.message || 'WebSocket error');
        this.emit('error', error);
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      };

      this.ws.onclose = (event) => {
        this.isAuthenticated = false;
        this.isRegistered = false;
        this.emit('disconnected', { code: event.code, reason: event.reason });

        if (!this.shouldStop && this.autoReconnect) {
          this.emit('reconnecting', { delay: this.reconnectDelay });
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch((err) => {
              this.emit('error', err);
            });
          }, this.reconnectDelay);
        }
      };
    });
  }

  /**
   * Send the initial AuthenticationMessage.
   * Format: { AccessToken, Group, ProtocolVersion: 1, Headers: {} }
   */
  _sendAuthHandshake() {
    const authMessage = {
      AccessToken: this.accessToken,
      Group: this.bancoId,
      ProtocolVersion: this.protocolVersion || PROTOCOL_VERSION,
      Headers: {},
    };
    this.ws.send(JSON.stringify(authMessage));
  }

  /**
   * Handle incoming parsed JSON messages from Secullum Cloud.
   * @param {object} msg
   * @param {(err?: Error) => void} cb
   */
  _handleIncomingMessage(msg, cb) {
    // 1. Initial Authentication Response
    if (msg.ResponseAuth !== undefined || msg.responseAuth !== undefined) {
      const resp = (msg.ResponseAuth || msg.responseAuth || '').toLowerCase();
      if (resp === 'ok') {
        this.isAuthenticated = true;
        this.emit('authenticated', { bancoId: this.bancoId });
        // Register agent on Hub Comunicacao
        this._registerAgent();
        if (cb) cb();
      } else {
        const err = new Error(`RealTime authentication failed: ${resp}`);
        this.emit('error', err);
        if (cb) cb(err);
        this.disconnect();
      }
      return;
    }

    // 2. Heartbeat Ping from Cloud
    if (msg.HubName === '--PING--' || msg.hubName === '--PING--') {
      const pong = { HubName: '--PONG--' };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(pong));
      }
      this.emit('ping', { timestamp: new Date() });
      return;
    }

    // 3. Hub Method Invocation / Event from Cloud
    const hubName = msg.HubName || msg.hubName;
    const eventName = msg.EventName || msg.eventName || msg.MethodName || msg.methodName;
    const args = msg.Arguments || msg.arguments || [];

    if (hubName) {
      this.emit('cloud_event', {
        hubName,
        eventName,
        args,
        timestamp: new Date(),
      });

      if (eventName) {
        // Emit specific event name
        this.emit(eventName, ...args);
      }
    }
  }

  /**
   * Register agent with the cloud after authentication.
   * Method: 'EstabelecerConexaoAgente' on Hub 'Comunicacao'
   */
  _registerAgent() {
    const equipIds = (this.equipments || [])
      .map((e) => (typeof e === 'number' ? e : Number(e.Id ?? e.id ?? e)))
      .filter((id) => !Number.isNaN(id));

    // Ensure statusEquipamentos and statusBobina maps have keys for all registered equipment
    const statusEquip = { ...this.statusEquipamentos };
    const statusBob = { ...this.statusBobina };
    for (const id of equipIds) {
      if (statusEquip[id] === undefined && statusEquip[String(id)] === undefined) {
        statusEquip[id] = true;
      }
      if (statusBob[id] === undefined && statusBob[String(id)] === undefined) {
        statusBob[id] = 'Normal';
      }
    }

    const payload = {
      NomeComputador: os.hostname(),
      VersaoServicoComunicacao: AGENT_VERSION,
      ListaEquipamentos: equipIds,
      StatusBobina: statusBob,
      StatusEquipamentos: statusEquip,
      LeitoresBiometricos: [],
      Instancia: this.instancia || '',
      MAC: getPrimaryMacAddress(),
    };

    this.sendHubMethod('Comunicacao', 'EstabelecerConexaoAgente', [payload]);
    this.isRegistered = true;
    this.emit('registered', payload);
  }

  /**
   * Send an RPC message to a Secullum RealTime Hub.
   * Format: { HubName, MethodName, Arguments: [...], AllowParallelProcessing: false }
   * @param {string} hubName
   * @param {string} methodName
   * @param {Array<any>} [args=[]]
   */
  sendHubMethod(hubName, methodName, args = []) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const msg = {
      HubName: hubName,
      MethodName: methodName,
      Arguments: Array.isArray(args) ? args : [args],
      AllowParallelProcessing: false,
    };

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send progress update to Secullum Cloud for an equipment communication.
   * @param {number} equipId
   * @param {string} description
   * @param {number} [progress=0]
   */
  sendCommunicationProgress(equipId, description, progress = 0) {
    this.sendHubMethod('Comunicacao', 'InformarAndamentoComunicacao', [
      equipId,
      description,
      progress,
    ]);
  }

  /**
   * Inform Secullum Cloud of equipment connection status.
   * Method: 'InformarStatusEquipamento' on Hub 'Comunicacao'
   * Arguments: [ equipamentoId (int), conectado (bool) ]
   * @param {number|string} equipId
   * @param {boolean} isConnected
   */
  informarStatusEquipamento(equipId, isConnected) {
    const id = Number(equipId);
    const conn = Boolean(isConnected);
    this.statusEquipamentos[id] = conn;
    this.sendHubMethod('Comunicacao', 'InformarStatusEquipamento', [id, conn]);
  }

  /**
   * Inform Secullum Cloud of equipment paper roll status.
   * Method: 'InformarStatusBobina' on Hub 'Comunicacao'
   * Arguments: [ equipamentoId (int), status (string) ]
   * @param {number|string} equipId
   * @param {string} status
   */
  informarStatusBobina(equipId, status) {
    const id = Number(equipId);
    const st = String(status || 'Normal');
    this.statusBobina[id] = st;
    this.sendHubMethod('Comunicacao', 'InformarStatusBobina', [id, st]);
  }

  /**
   * Inform Secullum Cloud of communication task completion.
   * Method: 'InformarTerminoComunicacao' on Hub 'Comunicacao'
   * Arguments: [ equipamentoId (int), tarefa (int TipoTarefa), mensagemErro (string) ]
   * @param {number|string} equipId
   * @param {number} tarefa
   * @param {string} [mensagemErro='']
   */
  informarTerminoComunicacao(equipId, tarefa, mensagemErro = '') {
    this.sendHubMethod('Comunicacao', 'InformarTerminoComunicacao', [
      Number(equipId),
      Number(tarefa),
      String(mensagemErro || ''),
    ]);
  }

  /**
   * Backward-compatible alias for informing equipment status.
   * Dispatches exact Hub method 'InformarStatusEquipamento' to Secullum Cloud.
   * @param {number} equipId
   * @param {boolean} isConnected
   */
  sendEquipmentStatus(equipId, isConnected) {
    this.informarStatusEquipamento(equipId, isConnected);
  }

  /**
   * Request Secullum Cloud to process punch records stored in TabelaTemporaria.
   * Discovered via REA from ComunicacaoService.ReceberRegistrosTabelaTemporariaAsync.
   * Method: 'ReceberRegistrosTabelaTemporaria' on Hub 'Comunicacao'
   */
  receberRegistrosTabelaTemporaria() {
    this.sendHubMethod('Comunicacao', 'ReceberRegistrosTabelaTemporaria', []);
  }

  /**
   * Inform Secullum Cloud about the last collected NSR of an equipment.
   * Method: 'InformarNsrEquipamento' on Hub 'Comunicacao'
   * @param {number|string} equipId
   * @param {number} nsr
   */
  informarNsrEquipamento(equipId, nsr) {
    this.sendHubMethod('Comunicacao', 'InformarNsrEquipamento', [Number(equipId), Number(nsr)]);
  }

  /**
   * Inform Secullum Cloud of updated equipment configuration string (e.g. updated UltimoNSR).
   * Discovered via REA from ComunicacaoService.InformarConfiguracoesEquipamentoAsync.
   * Method: 'InformarConfiguracoesEquipamento' on Hub 'Comunicacao'
   * Arguments: [ equipamentoId (int), configuracao (string) ]
   * @param {number|string} equipId
   * @param {string} configuracao
   */
  informarConfiguracoesEquipamento(equipId, configuracao) {
    this.sendHubMethod('Comunicacao', 'InformarConfiguracoesEquipamento', [
      Number(equipId),
      String(configuracao || ''),
    ]);
  }

  /**
   * Notify Secullum Cloud that an equipment is added to this agent.
   * Method: 'AdicionarEquipamentoAgente' on Hub 'Comunicacao'
   * @param {number|string} equipId
   */
  addEquipment(equipId) {
    this.sendHubMethod('Comunicacao', 'AdicionarEquipamentoAgente', [Number(equipId)]);
  }

  /**
   * Notify Secullum Cloud that an equipment is removed from this agent.
   * Method: 'RemoverEquipamentoAgente' on Hub 'Comunicacao'
   * @param {number|string} equipId
   */
  removeEquipment(equipId) {
    this.sendHubMethod('Comunicacao', 'RemoverEquipamentoAgente', [Number(equipId)]);
  }

  /**
   * Gracefully disconnect from the gateway.
   */
  disconnect() {
    this.shouldStop = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isAuthenticated = false;
    this.isRegistered = false;
  }
}

module.exports = {
  DEFAULT_REALTIME_URL,
  AGENT_VERSION,
  PROTOCOL_VERSION,
  TipoTarefa,
  getPrimaryMacAddress,
  RealTimeGateway,
};
