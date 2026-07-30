O que eu classificaria como pendências críticas

1. SignatureVerificationService

Esse é o item mais importante.

O relatório diz:

usa hash em vez de verificação Ed25519 real

Isso significa que ainda não existe autenticação verdadeira.

Na prática deveria ser algo como:

message
↓
hash
↓
Ed25519.verify(
publicKey,
signature,
hash
)
↓
válido?

Enquanto isso não existir, qualquer peer pode fabricar mensagens.

Prioridade: CRÍTICA

2. SecureChannelService

Outro ponto crítico.

Usar um digest não é criptografar.

Hoje parece algo parecido com:

digest(payload)

Mas deveria existir:

Noise XX

↓

troca de chaves

↓

session keys

↓

AES-GCM
ou
ChaCha20-Poly1305

Esse serviço protege toda a comunicação.

Prioridade: CRÍTICA

3. ChunkService

Gostei da decisão de remover o placeholder.

É melhor lançar:

throw new Error(
"Libp2p stream not implemented"
)

do que fingir que funciona.

Mas ainda falta:

Peer A

↓

request chunk

↓

libp2p stream

↓

Peer B

↓

stream bytes

↓

reassembly

↓

SQLite 4. EventBus → Feed

Você comentou:

placeholder para subscrição de eventos

Isso significa que ainda existe um gargalo.

Idealmente:

Network

↓

SyncService

↓

EventBus

↓

FeedScreen

sem polling.

Uma observação sobre os IDs

O relatório diz que alguns lugares trocaram Math.random() por contadores.

Isso depende do contexto.

Para eventos locais:

event_0001
event_0002

é perfeitamente aceitável.

Mas para objetos distribuídos:

posts
peers
transações
chunks
evidências

eu usaria IDs derivados do conteúdo ou UUIDs criptograficamente seguros.

Exemplo:

postId = SHA256(
authorPublicKey

- timestamp
- contentHash
  )

Assim todos os peers chegam exatamente ao mesmo ID.

O próximo passo

Eu faria uma última auditoria, mas desta vez procurando não por mocks, e sim por implementações simplificadas.

Itens a procurar:

TODO

FIXME

throw new Error

Not implemented

Placeholder

Temporary

Stub

Digest usado como criptografia

Hash usado como assinatura

Implementação simplificada

Libp2p não implementado

Noise simplificado

Ed25519 simplificado

AES fake

return true

return false

return []

return {}

console.warn("Not implemented")

console.error("TODO")

implement later

Essa auditoria é diferente da anterior porque ela encontra coisas que não são mocks, mas ainda não representam a funcionalidade real.
