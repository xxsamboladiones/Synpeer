# Phase 14 - Conectividade autonoma e convergencia da rede

## Objetivo

Fazer a malha P2P manter uma unica sessao por peer, recuperar conexoes sem intervencao
manual e convergir o estado social depois de reloads, quedas e particoes temporarias.

## Principios

- Cada peer possui um unico coordenador de negociacao e sessao.
- O transporte detecta liveness fisico; o coordenador decide timeout, retry e reconexao.
- Signaling transporta apenas dados efemeros de estabelecimento da conexao.
- `sessionId` identifica uma negociacao WebRTC e respostas antigas sao rejeitadas.
- Empates de ofertas simultaneas sao resolvidos pela ordem deterministica dos peer IDs.
- Reconexao e sincronizacao sao retomaveis e idempotentes.
- Estado duravel fica em repositories IndexedDB, nunca no servidor de signaling.

## Bloco 14.1 - Coordenacao unica de sessoes WebRTC

- [x] Criar `PeerSessionCoordinator`.
- [x] Compartilhar chamadas concorrentes de conexao para o mesmo peer.
- [x] Vincular a oferta WebRTC ao peer remoto desde sua criacao.
- [x] Resolver glare de forma deterministica.
- [x] Rejeitar offers e answers obsoletos por `sessionId`.
- [x] Fechar negociacoes substituidas antes de aceitar uma nova.
- [x] Limpar estado do coordenador no disconnect, reset e stop.
- [x] Remover os locks globais que competiam com o lifecycle do runtime.
- [x] Cobrir concorrencia, glare, sinais antigos e cleanup em testes.

## Bloco 14.2 - Lifecycle e reconexao centralizados

- [x] Tornar o coordenador o unico proprietario de timeout de negociacao e reconnect.
- [x] Manter heartbeat e janela de desconexao no transporte como deteccao de liveness.
- [x] Remover retries concorrentes do runtime e dos services de peer.
- [x] Aplicar backoff com jitter deterministico e limite de tentativas por janela.
- [x] Diferenciar desconexao transitiva, peer offline, falha ICE e falha de signaling.
- [x] Fechar e liberar sessoes confirmadamente falhas antes de renegociar.
- [x] Retomar peers aprovados automaticamente depois de reload.
- [x] Cobrir timeout, heartbeat silencioso, backoff, deduplicacao e restauracao em testes.

## Bloco 14.3 - Estado de entrega transacional

- [x] Migrar envelopes, recibos, inbox e outbox para repositories IndexedDB tipados.
- [x] Persistir transicao de estado e cursor na mesma transacao.
- [x] Recuperar itens `sending` interrompidos como `queued`.
- [x] Implementar retencao e garbage collection de recibos.
- [x] Adicionar recibos de leitura sem expor conteudo aos relays.

## Bloco 14.4 - Anti-entropy por peer e entidade

- [x] Persistir checkpoint por peer e tipo de entidade.
- [x] Comparar manifestos por faixas de hash.
- [x] Sincronizar tombstones, edicoes e objetos ausentes.
- [x] Retomar paginas interrompidas pelo ultimo cursor confirmado.
- [x] Evitar full sync quando o manifesto nao mudou.

## Bloco 14.5 - Interface orientada a eventos

- [x] Unificar subscriptions de feed, chat, notificacoes, perfil e peers.
- [x] Atualizar telas sem polling e sem reload.
- [x] Exibir estados reais de conexao, sync e entrega.
- [x] Oferecer retry apenas para falhas recuperaveis.

## Bloco 14.6 - Validacao de malha

### 14.6.1 - Laboratorio reproduzivel

- [x] Criar harness E2E com quatro contextos de navegador isolados: A, B, C e D.
- [x] Iniciar Expo e signaling local em portas livres durante o teste.
- [x] Criar identidades e storages independentes sem fixtures sociais mockadas.
- [x] Montar somente as arestas A-B, B-C e C-D.
- [x] Expor diagnostico seguro para sessoes, sync e downloads sem chaves ou payloads.
- [x] Coletar logs estruturados e anexar trace apenas quando um cenario falhar.

### 14.6.2 - Sessoes e reconexao

- [x] Disparar ofertas simultaneas nos dois lados de uma aresta.
- [x] Confirmar uma unica sessao autenticada por par e fechamento da negociacao perdedora.
- [x] Recarregar B e confirmar reconexao automatica com A e C.
- [x] Fechar e reabrir B preservando IndexedDB para simular uma particao real.
- [x] Confirmar backoff, ausencia de loop de PeerConnections e cleanup de sessoes antigas.

### 14.6.3 - Convergencia social

- [x] Publicar em A e confirmar propagacao A-B-C-D sem reload.
- [ ] Particionar B, editar e remover conteudo em lados diferentes da malha.
- [ ] Restaurar B e validar convergencia de revisoes, interacoes e tombstones.
- [x] Confirmar IDs unicos, assinaturas validas e ausencia de duplicatas.
- [ ] Confirmar retomada pelos checkpoints sem full sync desnecessario.

### 14.6.4 - Chat privado por relays

- [x] Estabelecer a relacao social necessaria entre A e D.
- [x] Enviar mensagem A-D usando B e C apenas como relays.
- [x] Confirmar entrega e recibo de leitura fim a fim.
- [x] Verificar que B e C nao persistem plaintext nem exibem a conversa.
- [ ] Particionar um relay e confirmar retomada da outbox apos reconexao.

### 14.6.5 - Midia por replica alternativa

- [x] Publicar uma imagem em A e aguardar replicas validadas em B e C.
- [ ] Retirar A da malha e limpar a copia local de D.
- [x] Baixar novamente em D a partir de C ou B.
- [x] Validar hashes de chunks e do objeto reconstruido.
- [ ] Confirmar troca de candidato quando uma replica anuncia dados ausentes ou corrompidos.

### 14.6.6 - Correcao e gates

- [x] Corrigir as falhas encontradas sem aumentar timeouts para mascara-las.
- [x] Tornar os cenarios deterministas e independentes de Supabase.
- [x] Executar lint, typecheck, testes unitarios, integracao e export web.
- [x] Executar a matriz E2E ao menos tres vezes consecutivas sem flake.
- [ ] Registrar tempos de conexao, reconexao, convergencia e recuperacao de midia.

## Criterio de conclusao

A fase termina quando a malha A-B-C-D recupera conexoes e converge posts, interacoes,
chat e midia sem reload manual, sem sessoes WebRTC duplicadas e sem depender de dados
persistidos no signaling.
