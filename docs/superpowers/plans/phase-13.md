# Phase 13 - Entrega confiavel, convergencia e privacidade P2P

## Objetivo

Transformar os fluxos P2P existentes em uma camada de entrega previsivel. A rede deve
continuar funcionando durante desconexoes, reconectar sem criar sessoes duplicadas e
convergir sem exigir reload da interface.

## Principios

- Transporte pode entregar mais de uma vez; repositories materializam uma unica vez.
- Conteudo publico usa gossip autenticado.
- Conteudo privado usa envelope cifrado e roteamento direcionado.
- ACK de um relay confirma apenas custodia local.
- Somente recibo assinado pelo destinatario confirma entrega fim a fim.
- Estado de entrega e persistido antes da primeira tentativa de envio.
- Supabase continua restrito a signaling e presenca efemera.

## Bloco 13.1 - Chat privado e recibos fim a fim

- [x] Definir envelope privado versionado.
- [x] Cifrar mensagens com X25519 e AES-256-GCM.
- [x] Assinar o envelope com a identidade Ed25519.
- [x] Impedir que relays persistam texto em claro.
- [x] Criar recibo de entrega assinado pelo destinatario.
- [x] Manter o envelope pendente ate o recibo final.
- [x] Restringir sync de chat aos participantes da conversa.
- [x] Exibir estado de entrega na conversa.
- [ ] Persistir recibos e envelopes em repository IndexedDB transacional.
- [ ] Implementar recibo de leitura.

## Bloco 13.2 - Coordenacao de sessoes

- [ ] Criar `PeerSessionCoordinator` como unico dono das conexoes WebRTC.
- [ ] Garantir uma sessao ativa ou em negociacao por peer.
- [ ] Rejeitar offers e answers obsoletos por negotiation id.
- [ ] Tratar glare de forma deterministica.
- [ ] Limitar tentativas e aplicar backoff com jitter seguro.
- [ ] Fechar recursos, data channels e timers de sessoes substituidas.

## Bloco 13.3 - Outbox e inbox duraveis

- [ ] Criar repositories tipados para outbox e inbox.
- [ ] Estados: queued, sending, relayed, delivered, read e failed.
- [ ] Persistir antes do envio.
- [ ] Retomar automaticamente no bootstrap e na abertura de conexao.
- [ ] Deduplicar materializacao por object id e content hash.
- [ ] Aplicar garbage collection apenas depois da retencao de recibos.

## Bloco 13.4 - Anti-entropy

- [ ] Checkpoint por peer e por entidade.
- [ ] Manifesto por faixa de hashes.
- [ ] Comparacao de manifestos apos handshake e reconexao.
- [ ] Recuperacao de objetos ausentes e tombstones.
- [ ] Retomada de paginas interrompidas sem reiniciar o sync.

## Bloco 13.5 - Interface reativa

- [ ] Uma assinatura de mudancas dos repositories por runtime.
- [ ] Feed, chat, notificacoes e perfil atualizados sem polling ou reload.
- [ ] Estados reais de entrega, download, retry e conexao.
- [ ] Diagnostico de fila sem expor payload privado.

## Bloco 13.6 - Testes de malha

- [ ] A-B-C-D: post publico converge em todos os peers.
- [ ] A-B-C-D: chat A-D so pode ser lido por A e D.
- [ ] Relay offline retoma envelope persistido.
- [ ] Recibo duplicado nao duplica materializacao.
- [ ] Reload recria a sessao sem duplicar `RTCPeerConnection`.
- [ ] Edicao e tombstone convergem depois de particao.
- [ ] Midia antiga pode ser recuperada de qualquer replica valida.

## Criterio de conclusao

A fase termina quando os testes de quatro peers passam sem reload manual, mensagens
privadas possuem confirmacao do destinatario e nenhum relay consegue acessar seu
conteudo em claro.
