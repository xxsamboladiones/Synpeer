# Phase 6 — Integração da Rede P2P

> Objetivo: conectar toda a arquitetura existente para transformar os componentes implementados em uma rede social P2P totalmente funcional.

---

# Objetivos

Ao final desta fase:

- Todos os serviços serão inicializados automaticamente.
- A rede P2P ficará ativa durante toda a execução do aplicativo.
- Os dispositivos descobrirão peers automaticamente.
- Posts serão sincronizados entre dispositivos.
- O banco SQLite será utilizado por toda a aplicação.
- Wallet, identidade, consenso e mídia utilizarão os serviços reais.
- Nenhuma tela utilizará dados mockados ou serviços nulos.

---

# Situação Atual

## Arquitetura

Status:

✅ Completa

Todos os módulos existem.

## Integração

Status:

⚠ Parcial

Grande parte dos serviços não participa do fluxo principal da aplicação.

---

# PHASE 6.1 — Runtime da Aplicação

## Objetivo

Transformar o AppService em um verdadeiro runtime.

Criar:

```
ApplicationRuntime
```

Responsável por inicializar:

- DatabaseService
- CryptoService
- WalletService
- NetworkService
- PeerDiscovery
- PeerManager
- SyncService
- ReputationService
- DistributedStorageService
- MediaTransferService
- ConsensusEngine

Fluxo:

```
App Start

↓

ApplicationRuntime

↓

Inicializar Banco

↓

Inicializar Identidade

↓

Inicializar Wallet

↓

Inicializar Rede

↓

Descobrir Peers

↓

Iniciar Protocolos

↓

Aplicação pronta
```

Critérios

- [ ] Nenhum serviço null
- [ ] Inicialização única
- [ ] Tratamento de falhas
- [ ] Reinicialização automática

---

# PHASE 6.2 — Inicialização da Rede

Objetivo

A rede inicia automaticamente.

Fluxo

```
ApplicationRuntime

↓

NetworkService.start()

↓

PeerManager.start()

↓

PeerDiscovery.start()

↓

mDNS

↓

Bootstrap

↓

DHT

↓

Primeiros peers encontrados
```

Critérios

- [ ] PeerDiscovery ativo
- [ ] PeerManager ativo
- [ ] DHT funcionando
- [ ] mDNS funcionando

---

# PHASE 6.3 — Identidade

Fluxo

Primeira execução

```
Gerar chave Ed25519

↓

Salvar SQLite

↓

Publicar PeerIdentity
```

Execuções futuras

```
Carregar identidade

↓

Registrar na rede
```

Critérios

- [ ] Identidade persistente
- [ ] Assinaturas funcionando
- [ ] Verificação funcionando

---

# PHASE 6.4 — Banco de Dados

Objetivo

Toda informação passa pelo SQLite.

Inicializar

```
DatabaseService

↓

Repositories

↓

PostRepository

↓

WalletRepository

↓

MediaRepository
```

Eliminar completamente

- mocks
- listas em memória
- dados temporários

Critérios

- [ ] Banco aberto
- [ ] Repositórios ativos
- [ ] Persistência funcionando

---

# PHASE 6.5 — Sincronização

Objetivo

Ativar SyncService.

Fluxo

```
Novo Peer

↓

Handshake

↓

Troca lastSyncTimestamp

↓

POST_REQUEST

↓

POST_RESPONSE

↓

SQLite

↓

Feed atualizado
```

Critérios

- [ ] Sync automático
- [ ] Sync incremental
- [ ] Deduplicação

---

# PHASE 6.6 — Feed Distribuído

Fluxo

Criar post

↓

SQLite

↓

Assinar

↓

POST_ANNOUNCE

↓

Peers recebem

↓

POST_REQUEST

↓

Validação

↓

SQLite

↓

Feed atualizado

Critérios

- [ ] Feed local
- [ ] Feed remoto
- [ ] Atualização automática

---

# PHASE 6.7 — Protocolos

Todos os protocolos passam a ser registrados automaticamente.

Registrar

- PostProtocol
- MediaProtocol
- IdentityProtocol
- SyncProtocol
- PingProtocol

Fluxo

```
Nova conexão

↓

Registrar protocolos

↓

Receber mensagens

↓

Despachar handlers
```

---

# PHASE 6.8 — Transferência de Mídia

Fluxo

Selecionar imagem

↓

ChunkService

↓

SQLite

↓

MediaTransferService

↓

Peers

↓

Download sob demanda

↓

Reconstrução

Critérios

- [ ] Upload
- [ ] Download
- [ ] Cache
- [ ] Reassembly

---

# PHASE 6.9 — Economia

Fluxo

Contribuição

↓

RewardCalculator

↓

Ledger

↓

Wallet

↓

Sync

↓

Peers

Critérios

- [ ] Ledger atualizado
- [ ] Wallet sincronizada
- [ ] Recompensas funcionando

---

# PHASE 6.10 — Consenso

Fluxo

Nova contribuição

↓

EvidenceManager

↓

WitnessManager

↓

VoteManager

↓

ConsensusEngine

↓

Resultado

↓

Ledger

Critérios

- [ ] Quorum
- [ ] Votação
- [ ] Evidências
- [ ] Validação

---

# PHASE 6.11 — Eventos

Criar EventBus central.

Eventos

- PeerConnected
- PeerDisconnected
- PostCreated
- PostReceived
- MediaReceived
- WalletUpdated
- ConsensusReached
- ReputationChanged

Todas as telas escutam apenas eventos.

Nenhuma tela conversa diretamente com serviços internos.

---

# PHASE 6.12 — Recuperação de Falhas

Implementar

- reconexão automática
- reinício de protocolos
- retry exponencial
- watchdog da rede
- health check dos serviços

---

# PHASE 6.13 — Testes de Integração

## Cenário 1

- [ ] Dois dispositivos descobrem um ao outro.

## Cenário 2

- [ ] Criar post no dispositivo A.
- [ ] Post aparece no dispositivo B.

## Cenário 3

- [ ] Desligar internet.
- [ ] Criar posts.
- [ ] Reconectar.
- [ ] Sincronização automática.

## Cenário 4

- [ ] Compartilhar imagem.

## Cenário 5

- [ ] Reiniciar aplicativo.
- [ ] Banco restaurado.
- [ ] Rede reconectada.

## Cenário 6

- [ ] Consenso executado.

## Cenário 7

- [ ] Wallet sincronizada.

---

# Critérios de Conclusão

## Runtime

- [ ] Todos os serviços inicializados.

## Banco

- [ ] SQLite funcionando.

## Rede

- [ ] Descoberta automática.

## Sincronização

- [ ] Posts sincronizando.

## Protocolos

- [ ] Todos registrados.

## Identidade

- [ ] Assinaturas válidas.

## Economia

- [ ] Wallet operacional.

## Consenso

- [ ] Sistema ativo.

## Mídia

- [ ] Upload e download funcionando.

## Offline

- [ ] Sincronização após reconexão.

---

# Objetivo Final

Ao término da Phase 6, toda a arquitetura P2P existente estará integrada em um único runtime operacional. O aplicativo deixará de possuir componentes isolados e passará a executar um fluxo contínuo de inicialização, descoberta de peers, sincronização de conteúdo, validação criptográfica, armazenamento distribuído e atualização da interface, permitindo que múltiplos dispositivos formem uma rede social P2P funcional sem depender de servidores centrais.
