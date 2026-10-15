# Como Contribuir para o Secullum RH Communication Agent CLI

Agradecemos o seu interesse em contribuir para o projeto **Secullum RH Standalone Communication Agent**!

Este projeto é uma alternativa de código aberto, **100% autônoma e independente** do agente oficial do Secullum RH, desenvolvida integralmente por engenharia reversa para comunicar-se diretamente com a Nuvem Secullum PontoWeb e com relógios de ponto físicos (REPs) e leitores biométricos.

---

## 🧭 Princípios Fundamentais do Projeto

1. **Zero Dependências Externas em Produção:**
   Toda a lógica de execução deve utilizar exclusivamente os módulos nativos do Node.js (`node:net`, `node:crypto`, `node:events`, `node:fs`, `node:os`, `fetch`, `WebSocket`). **Não adicione dependências de terceiros no `dependencies` do `package.json`**.
2. **Compatibilidade Multiplataforma Real:**
   Todas as funcionalidades devem operar de forma idêntica e sem quebras tanto no **Windows** quanto no **Linux** (incluindo servidores headless, contêineres Docker e Raspberry Pi).
3. **Documentação Rigorosa de Protocolos:**
   Qualquer novo protocolo proprietário de fabricante de relógio ou endpoint da nuvem descoberto deve ser devidamente documentado com estruturas de pacotes, offsets e exemplos no `README.md`.

---

## 🛠️ Configuração do Ambiente de Desenvolvimento

### 1. Pré-requisitos
- **Node.js**: >= 20.0.0 (ou 18+)
- **Git**

### 2. Clonando o Repositório
```bash
git clone https://github.com/SEU_USUARIO/secullum-agent-cli.git
cd secullum-agent-cli
```

### 3. Executando Localmente em Modo Desenvolvimento
Você pode rodar o agente diretamente via Node.js sem necessidade de compilação prévia:
```bash
# Visualizar dashboard de status:
node bin/cli.js status

# Ajuda com todos os comandos:
node bin/cli.js --help
```

### 4. Compilando o Executável Autônomo (Sem Node.js)
Para testar a compilação do executável único via *Node.js SEA (Single Executable Application)*:
```bash
npm run build
```
O executável final será gerado em:
- **Windows:** `dist/secullum-agent.exe`
- **Linux:** `dist/secullum-agent`

---

## 🧪 Diretrizes de Testes e Validação

Antes de enviar um Pull Request, certifique-se de que todos os arquivos JavaScript passam pela verificação de sintaxe e pelos testes básicos:

```bash
# Executar a suíte de validação:
npm test
```

Para verificar arquivos individualmente:
```bash
node --check bin/cli.js
node --check scripts/build.js
node --check src/auth.js
node --check src/pontoweb.js
node --check src/realtime.js
node --check src/protocols/henry.js
node --check src/protocols/controlid.js
node --check src/protocols/dispatcher.js
node --check src/biometric.js
node --check src/daemon.js
```

---

## 🚀 Como Submeter um Pull Request (PR)

1. Faça um Fork do repositório no GitHub.
2. Crie uma branch para a sua funcionalidade ou correção a partir da `main`:
   ```bash
   git checkout -b feature/suporte-madis-mdrep
   ```
3. Realize seus commits com mensagens claras e semânticas:
   ```bash
   git commit -m "feat(protocols): adiciona suporte ao protocolo Madis MD Rep Evo"
   ```
4. Envie a branch para o seu fork:
   ```bash
   git push origin feature/suporte-madis-mdrep
   ```
5. Abra um **Pull Request** no GitHub detalhando as alterações e testes realizados em hardware físico ou ambiente simulado.
6. Acompanhe a execução do workflow de CI (`ci.yml`) para garantir que os testes passaram no Windows e no Linux.

---

## 📜 Código de Conduta

Mantenha um ambiente respeitoso, colaborativo e construtivo. Toda contribuição que agregue valor, estabilidade ou novos protocolos ao ecossistema é muito bem-vinda!
