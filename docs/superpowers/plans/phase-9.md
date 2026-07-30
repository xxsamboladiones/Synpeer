# Phase 5 — Rede P2P Real (Distributed Network)

> Objetivo: transformar o Synpeer de uma aplicação com arquitetura P2P para uma rede P2P totalmente funcional, onde dispositivos descobrem uns aos outros, sincronizam conteúdo, distribuem mídia e funcionam sem depender de servidores centrais.

---

# Objetivos

Ao final desta fase será possível:

- Descobrir automaticamente outros dispositivos.
- Sincronizar posts entre celulares.
- Validar criptograficamente todo conteúdo recebido.
- Replicar dados entre vários peers.
- Compartilhar imagens e vídeos em chunks.
- Funcionar offline.
- Sincronizar automaticamente quando encontrar outros peers.
- Resistir a spam e nós maliciosos.
- Operar sem qualquer backend central.

---

# Arquitetura Geral

```
                 +------------------+
                 |   Bootstrap Peer |
                 +---------+--------+
                           |
         ------------------+------------------
         |                 |                 |
+--------+-----+   +--------+-----+   +-------+------+
|   Device A   |   |   Device B   |   |   Device C   |
| SQLite       |   | SQLite       |   | SQLite       |
| Wallet       |   | Wallet       |   | Wallet       |
| Media Cache  |   | Media Cache  |   | Media Cache  |
+------+-------+   +------+-------+   +------+-------+
       |                  |                  |
       +------------------+------------------+
              P2P Encrypted Network
```

---

# PHASE 5.1 — Peer Discovery

## Objetivo

Eliminar completamente qualquer configuração manual de peers.

---

## 5.1.1 Bootstrap Peers

Implementar:

```
BootstrapService
```

Responsável por:

- conectar aos peers conhecidos
- baixar lista inicial
- descobrir novos peers

Exemplo:

```
bootstrap.json

[
   "peer1.synpeer.net",
   "peer2.synpeer.net",
   "peer3.synpeer.net"
]
```

---

## 5.1.2 Peer Exchange

Quando dois peers conectarem:

```
HELLO

↓

troca de peers conhecidos

↓

Peer List
```

Cada peer passa a conhecer novos nós.

---

## 5.1.3 mDNS

Na rede Wi-Fi local:

```
Device A

↓

Broadcast

↓

Device B encontra automaticamente
```

Sem internet.

---

## 5.1.4 DHT (Kademlia)

Criar:

```
DHTService
```

Responsável por:

- localizar peers
- localizar conteúdos
- localizar mídias

Cada peer mantém parte da tabela.

---

# PHASE 5.2 — Sincronização de Posts

## Objetivo

Dois celulares sincronizam conteúdo automaticamente.

---

## Fluxo

```
Celular A

↓

novo post

↓

assina

↓

salva SQLite

↓

anuncia hash

↓

Celular B recebe anúncio

↓

não possui

↓

solicita conteúdo

↓

verifica assinatura

↓

salva SQLite
```

---

## Serviços

```
SyncService

SyncProtocol

SyncQueue
```

---

## Mensagens

```
POST_ANNOUNCE

POST_REQUEST

POST_RESPONSE

POST_ACK
```

---

## Sincronização Incremental

Cada peer salva:

```
lastSyncTimestamp
```

Na próxima sincronização:

```
me envie apenas posts novos
```

---

# PHASE 5.3 — Resolução de Conflitos

Casos:

Mesmo post

↓

duas versões

ou

edições

ou

duplicações

---

Estratégia:

```
Maior versão

↓

Maior timestamp

↓

Maior cadeia de assinaturas
```

Nunca apagar imediatamente.

Marcar:

```
CONFLICT
```

Resolver posteriormente.

---

# PHASE 5.4 — Armazenamento Distribuído

Objetivo:

Todo conteúdo existir em vários peers.

---

Cada post:

```
Replication Factor = 5
```

Exemplo:

```
Peer A

↓

Replica em

B

C

D

E
```

---

## Garbage Collection

Conteúdo antigo:

```
último acesso

↓

30 dias

↓

e existe 5 cópias

↓

remover
```

---

## Política de retenção

Sempre manter:

- próprios posts
- favoritos
- posts recentes
- posts populares

---

# PHASE 5.5 — Sistema de Reputação

Criar:

```
ReputationService
```

Cada peer possui score.

---

Critérios positivos

✔ uptime

✔ respostas rápidas

✔ conteúdo válido

✔ bom histórico

---

Critérios negativos

✖ spam

✖ conteúdo inválido

✖ assinaturas falsas

✖ flood

---

Peers com maior reputação:

- sincronizam primeiro
- armazenam mais conteúdo
- recebem prioridade

---

# PHASE 5.6 — Sincronização Offline

Toda operação gera um evento.

Exemplo:

```
CreatePost

↓

OfflineQueue

↓

aguarda conexão

↓

envia
```

---

Fila

```
Pending

Sending

Confirmed

Failed

Retry
```

---

Reenvio automático

Backoff exponencial.

```
5s

10s

20s

40s

80s
```

---

Versionamento

Cada objeto possui:

```
version

updatedAt

signature
```

---

# PHASE 5.7 — Transferência de Mídia

Criar:

```
MediaTransferService
```

---

Fluxo

```
Imagem

↓

Chunk

↓

Chunk

↓

Chunk

↓

Peer
```

---

Chunk padrão

```
256 KB
```

---

Download sob demanda

Feed:

```
miniatura

↓

imagem somente quando abrir
```

---

Vídeos

```
streaming

↓

chunk

↓

buffer
```

---

Cache

```
LRU Cache
```

Configuração:

```
Máximo:

2 GB
```

Ao atingir:

```
remove mídia antiga
```

---

# PHASE 5.8 — Segurança

## Assinaturas

Todo conteúdo recebido:

```
VerifySignature()

↓

válido?

↓

SQLite
```

Caso contrário:

```
Descartar
```

---

Replay Attack

Cada mensagem possui:

```
nonce

timestamp

messageId
```

Mensagens repetidas:

```
ignorar
```

---

Rate Limiting

Cada peer:

```
100 req/min
```

Após isso:

```
cooldown
```

---

Criptografia

Todo tráfego:

```
TLS

+

Noise Protocol

ou

LibP2P Secure Channel
```

---

# PHASE 5.9 — Marco Principal

## Primeira sincronização entre dois dispositivos

Este é o maior objetivo desta fase.

Fluxo esperado:

```
Celular A

↓

Criar post

↓

Assinar

↓

SQLite

↓

Encontrar Celular B

↓

Enviar hash

↓

Celular B solicita

↓

Recebe

↓

Verifica assinatura

↓

Salva SQLite

↓

Feed atualizado
```

Sem servidores.

Sem APIs.

Sem Firebase.

Sem backend.

Apenas P2P.

---

# Critérios de conclusão

## Peer Discovery

- [ ] Bootstrap funcionando
- [ ] Peer Exchange
- [ ] mDNS
- [ ] DHT

---

## Sincronização

- [ ] Post sync
- [ ] Incremental sync
- [ ] Conflict resolution

---

## Distribuição

- [ ] Replicação
- [ ] Garbage collection
- [ ] Retenção

---

## Offline

- [ ] Queue
- [ ] Retry
- [ ] Versionamento

---

## Mídia

- [ ] Chunks
- [ ] Download sob demanda
- [ ] Cache

---

## Segurança

- [ ] Assinaturas
- [ ] Replay protection
- [ ] Rate limiting
- [ ] Criptografia

---

# Objetivo Final da Phase 5

Ao término desta fase, o Synpeer deverá operar como uma rede social distribuída totalmente funcional, na qual cada dispositivo atua simultaneamente como cliente, servidor e nó da rede. Posts, mídias e metadados serão sincronizados diretamente entre os participantes, preservando autenticidade por meio de assinaturas criptográficas, garantindo resiliência através de replicação distribuída e mantendo operação contínua mesmo em cenários offline. Essa infraestrutura servirá de base para todas as funcionalidades futuras, como comentários, curtidas, seguidores, mensagens privadas e grupos, que passarão a utilizar o mesmo mecanismo de sincronização P2P.
