# Phase 15 - Resiliencia de Internet e convergencia sob falhas

## Objetivo

Levar a malha validada na Phase 14 para condicoes reais de Internet, garantindo
conectividade atraves de NAT, entrega duravel por multiplos saltos, convergencia
deterministica depois de particoes e recuperacao de midia quando uma replica
estiver ausente ou corrompida.

A Phase 15 nao cria um backend social centralizado. Supabase ou o signaling local
continuam transportando somente sinais efemeros de conexao. Posts, perfis, chat,
recibos e midia permanecem armazenados e replicados pelos peers.

## Estado herdado

- `PeerSessionCoordinator` controla sessao unica, glare, timeout e reconexao.
- Inbox, outbox, envelopes e recibos possuem persistencia tipada em IndexedDB.
- Anti-entropy usa checkpoints, manifestos e tombstones.
- Feed, chat, notificacoes, perfil e peers atualizam por eventos.
- Chat privado atravessa relays sem expor texto em claro.
- Midia pode atravessar peers intermediarios e e validada por hash.
- O laboratorio A-B-C-D valida a malha local de forma reproduzivel.

## Lacunas que esta fase deve fechar

- Conexao entre redes reais ainda depende da disponibilidade de candidatos ICE
  diretos e nao possui uma estrategia TURN completa.
- A malha ainda nao foi validada com edicoes e exclusoes concorrentes durante
  uma particao real.
- A outbox persistida ainda precisa provar retomada quando todos os relays de uma
  rota ficam offline.
- A selecao de replica de midia ainda nao troca automaticamente de origem diante
  de chunk ausente, expirado ou corrompido.
- Nao existem metas operacionais e diagnostico suficiente para separar falha de
  signaling, ICE, sessao, sync, relay e storage.
- A validacao principal ainda ocorre em uma unica maquina e em rede local.

## Principios

- O servidor auxilia a descoberta e o signaling, mas nunca recebe conteudo social.
- WebRTC continua sendo o transporte de dados entre peers.
- TURN e um relay de pacotes criptografados, nao um repositorio de aplicacao.
- Toda operacao recebida e autenticada, idempotente, limitada e expiravel.
- Conflitos sao resolvidos por regras de dominio, nao apenas pelo relogio local.
- Recibo de relay nao equivale a recibo do destinatario.
- Recovery retoma do ultimo estado confirmado, sem reiniciar toda a sincronizacao.
- Falhas esperadas produzem estados tipados; nao geram loops ou spam de logs.
- Nenhum segredo, mensagem privada ou arquivo aparece em logs ou diagnosticos.

## Bloco 15.1 - Laboratorio de falhas e metas operacionais

- [x] Estender o harness A-B-C-D com um controlador deterministico de falhas.
- [x] Particionar e restaurar arestas sem destruir IndexedDB ou identidades.
- [x] Fechar e reabrir um contexto preservando seu perfil persistente.
- [ ] Injetar perda, atraso, duplicacao e reordenacao de mensagens de transporte.
- [ ] Permitir corromper uma replica de chunk somente no ambiente de teste.
- [x] Medir tempo de bootstrap, reconexao e convergencia social.
- [x] Medir tempo de entrega duravel.
- [ ] Medir tempo de reparo de midia.
- [x] Registrar um manifesto de cada execucao com topologia, seed e resultados.
- [ ] Coletar trace apenas em falha e sempre com dados sensiveis redigidos.

### Criterios de aceite

- O mesmo seed reproduz a mesma sequencia de falhas.
- Fechar e reabrir B preserva os dados e restaura A-B e B-C sem acao manual.
- Uma falha aponta sua camada: signaling, ICE, sessao, protocolo, sync ou storage.
- Os testes nao usam delays para simular sucesso.

## Bloco 15.2 - ICE, STUN e TURN para Internet real

- [ ] Criar configuracao tipada e validada de servidores ICE.
- [ ] Separar `IceServerProvider` da implementacao de signaling.
- [ ] Suportar credenciais TURN temporarias, sem segredo permanente no cliente.
- [ ] Rejeitar configuracao insegura ou incompleta em producao.
- [ ] Identificar se a rota selecionada e direta, reflexiva ou relay.
- [ ] Executar ICE restart antes de substituir uma sessao autenticada.
- [ ] Limitar negociacoes simultaneas e liberar `RTCPeerConnection` obsoleta.
- [ ] Integrar falha ICE ao backoff ja controlado pelo coordenador.
- [ ] Expor estado seguro de conectividade no health e na tela de peers.
- [ ] Validar conexao forcando `iceTransportPolicy: "relay"` em teste externo.

### Criterios de aceite

- Dois computadores em redes diferentes conectam sem copiar offer/answer.
- Uma rede que bloqueia conexao direta usa TURN automaticamente.
- Queda temporaria de rota tenta ICE restart sem criar varias sessoes.
- Chaves TURN, SDP completo e candidatos privados nao aparecem em logs.
- Signaling e TURN nao persistem posts, chat, perfis ou midia.

## Bloco 15.3 - Entrega duravel multi-hop

- [x] Fortalecer a outbox existente sem criar um segundo sistema de filas.
- [x] Formalizar estados `queued`, `sending`, `relayed`, `delivered`, `read`,
      `failed`, `expired` e `dead-letter`.
- [x] Persistir tentativa, proximo retry, rota, TTL e ultimo recibo atomicamente.
- [x] Diferenciar recibo de custodia do relay e recibo final do destinatario.
- [x] Retomar itens interrompidos depois de reload ou encerramento do app.
- [x] Selecionar outra rota quando o relay atual ficar indisponivel.
- [x] Deduplicar envelope e recibo em todos os saltos.
- [x] Limitar saltos, tamanho, tentativas e idade para impedir loops.
- [x] Limpar envelopes somente depois de estado terminal ou expiracao.
- [x] Manter payload cifrado para todos os peers intermediarios.

### Criterios de aceite

- A envia para D enquanto B ou C esta offline e a entrega continua quando uma
  rota valida reaparece.
- Reload de A, B, C ou D nao perde nem aplica duas vezes uma mensagem pendente.
- Um relay nao consegue produzir sozinho um recibo final valido de D.
- B e C nao armazenam nem exibem o texto em claro da conversa A-D.
- Expiracao termina retries e move o item para um estado diagnosticavel.

### Implementacao concluida em 2026-07-26

- A outbox `social_delivery_records` foi evoluida de registros v2 para v3 com
  leitura compativel dos dados antigos.
- IDs de entrega ignoram o caminho mutavel de gossip, mantendo deduplicacao
  estavel em todos os hops.
- Um ACK intermediario registra custodia `relayed`; somente recibos assinados
  pelo destinatario produzem `delivered` ou `read`.
- O relay persiste o envelope antes de confirmar custodia ao peer anterior.
- Leases `sending` sao recuperados no bootstrap depois de reload.
- Falhas repetidas terminam em `dead-letter`; idade excedida termina em
  `expired`, ambos preservados temporariamente para diagnostico.
- O E2E `durable-chat-relay.spec.ts` valida A-B-C-D com B offline, reload de A,
  reconexao, entrega unica e ausencia de plaintext em B/C.

### Validacao do bloco 15.3

- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test -- --runInBand`: 59 suites e 281 testes aprovados.
- `npm.cmd run test:e2e:mesh:repeat`: 9 cenarios aprovados em tres repeticoes.
- `npx.cmd expo export --platform web`: export web concluido.

## Bloco 15.4 - Convergencia deterministica durante particoes

- [x] Definir politica de conflito por entidade social.
- [x] Validar autoria, assinatura, revisao anterior e monotonicidade da revisao.
- [x] Usar hash canonico como desempate final, nunca ordem de chegada.
- [x] Tratar perfil e post como registros controlados pelo autor.
- [x] Tratar follow, reaction e comment como operacoes idempotentes.
- [x] Fazer tombstone vencer revisoes anteriores e impedir ressurreicao.
- [x] Reter tombstones ate o horizonte seguro de anti-entropy.
- [x] Rejeitar timestamp muito fora da janela sem depender dele como unica ordem.
- [x] Persistir a decisao de conflito e seu motivo sem armazenar payload em log.
- [x] Atualizar checkpoint somente depois da aplicacao integral da pagina.
- [x] Provar que manifestos iguais nao disparam full sync.

### Criterios de aceite

- Com B particionado, alteracoes concorrentes nos dois lados convergem para o
  mesmo estado depois da restauracao.
- Editar de um lado e excluir do outro nao ressuscita o post removido.
- Reacoes e comentarios nao duplicam apos replay, reordenacao ou reconexao.
- Todos os peers produzem os mesmos hashes de estado ao final.
- Relogios locais divergentes nao mudam o resultado deterministico.

### Implementacao concluida em 2026-07-29

- Posts, perfis, comentarios, reacoes, follows e mensagens possuem revisao
  monotona e referencia canonica para a revisao anterior.
- `SocialConflictResolver` aplica uma unica politica pura no recebimento em tempo
  real e no sync incremental: revisao, tombstone e hash canonico, nessa ordem.
- A ordem de chegada e o relogio local nao participam do desempate final.
- Tombstones de post, comentario e chat sao finais e nao podem ser
  ressuscitados por uma revisao ativa posterior.
- Decisoes de conflito sao persistidas em `social_conflict_decisions` somente
  com hashes, acao e motivo, sem copiar o payload social.
- O schema web foi migrado da versao 7 para a versao 8; tabelas sociais nativas
  recebem colunas de revisao por migracoes idempotentes.
- O protocolo v2 nao confirma checkpoint quando alguma aplicacao da pagina
  falha. Escritas anteriores da mesma pagina podem existir, mas sao
  idempotentes e reaplicadas na retomada; uma transacao fisica entre todos os
  repositories continua sendo uma melhoria de persistencia.
- O servico legado de conflito baseado em `parseFloat(version)`, timestamp e
  verificacao simulada foi removido.
- O E2E `partition-recovery.spec.ts` valida A-B-C-D, particao, restauracao,
  exclusao concorrente, tombstone persistido e hashes finais iguais.

### Validacao do bloco 15.4

- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test -- --runInBand`: 62 suites e 296 testes aprovados.
- `npm.cmd run test:e2e:mesh:repeat`: 9 cenarios aprovados em tres
  repeticoes.
- `npx.cmd expo export --platform web`: export web concluido.
- `npm.cmd run format:check`: pendente; o baseline atual possui 149 arquivos
  antigos ou gerados fora do padrao do Prettier. Nenhuma regra foi desativada e
  nenhuma reformatacao global fora do escopo foi aplicada.

## Bloco 15.5 - Reparacao e disponibilidade de midia

- [x] Versionar e assinar anuncios de disponibilidade de objetos e chunks.
- [x] Expirar anuncios antigos e remover peers comprovadamente indisponiveis.
- [x] Selecionar candidatos por integridade, disponibilidade e historico de falha.
- [x] Manter frames abaixo do limite do data channel com backpressure.
- [x] Retomar o download no primeiro chunk ausente depois de reload.
- [x] Rejeitar chunk cujo hash nao corresponde ao manifesto.
- [x] Trocar de replica sem reiniciar chunks ja validados.
- [x] Validar o hash do objeto completo depois da remontagem.
- [x] Colocar replica repetidamente corrompida em quarentena local.
- [x] Reparar o numero minimo configurado de replicas em segundo plano.
- [x] Respeitar quota de cache, retencao e garbage collection.

### Diagnostico de entrada

- `PeerMediaSyncService` ja baixa chunks por WebRTC, divide respostas grandes,
  valida SHA-256 por chunk e por objeto, alterna entre peers e restaura downloads
  parciais.
- O estado de download e os manifestos de disponibilidade ainda ficam em
  `LocalStorage`, sem schema versionado, transacao ou migracao formal.
- Manifestos v1 nao expiram, nao possuem sequencia persistida e podem continuar
  elegendo um peer que deixou de possuir o chunk.
- A selecao atual considera sucessos e falhas somente em memoria; reload apaga o
  historico e a quarentena nao existe.
- Partes recebidas aguardam em memoria sem limite agregado de bytes, prazo
  proprio ou janela de fluxo baseada no `bufferedAmount` do data channel.
- Um chunk invalido e rejeitado, mas a origem nao e ligada de forma duravel a
  essa falha e outra replica nao e necessariamente tentada com uma politica
  especifica para corrupcao.
- O cache remove objetos orfaos e aplica limite por idade, mas ainda nao considera
  downloads ativos, ultimo acesso, disponibilidade externa ou numero de replicas.
- `MediaTransferService`, `ChunkService` e os protocolos antigos coexistem com o
  caminho real. `MediaTransferService` ainda possui hash nao criptografico e cache
  somente em memoria; ele nao pode continuar exposto como servico de producao.
- `MediaObject` e `MediaChunk` ainda aceitam assinatura vazia. O manifesto do
  post autentica os hashes esperados, mas anuncios e custodia de replicas
  precisam de prova propria e versionada.

### Arquitetura alvo

#### Contratos de dominio

- `MediaManifest`: lista canonica e imutavel dos chunks esperados, tamanho, hash
  completo, algoritmo e versao.
- `MediaAvailabilityAnnouncementV2`: emissor, sequencia monotona, emissao,
  expiracao, objetos/chunks disponiveis e assinatura da identidade.
- `MediaDownloadJob`: estado persistido por objeto com chunks validados,
  tentativas por origem, cursor de retomada e erro seguro.
- `MediaReplicaObservation`: ultima disponibilidade confirmada por peer, sucesso,
  falha, latencia e validade.
- `MediaQuarantineRecord`: peer, objeto/chunk, motivo, evidencia por hash,
  inicio, expiracao e contagem de falhas.
- `MediaRepairPolicy`: replicas desejadas, replicas minimas, quota, concorrencia,
  retencao e limites de tentativa.

#### Servicos

- `MediaIntegrityService`: funcoes puras para validar manifesto, chunk, sequencia
  de posicoes e objeto remontado.
- `MediaAvailabilityService`: cria, assina, valida, persiste e expira anuncios.
- `MediaSourceSelector`: ordena fontes de forma deterministica usando anuncio
  valido, disponibilidade do chunk, sucesso, falha, backoff e quarentena.
- `MediaTransferScheduler`: controla jobs, concorrencia, tamanho de frame,
  `bufferedAmount`, timeout, cancelamento e retomada.
- `MediaRepairService`: mede replicas frescas, agenda novas replicas e confirma
  reparo somente depois de um anuncio valido do peer receptor.
- `MediaRetentionService`: aplica quota e GC sem remover download ativo, unica
  replica conhecida ou midia protegida pela politica local.

#### Persistencia

- Migrar o banco web da versao 8 para a versao 9.
- Criar stores/tabelas tipadas para jobs, anuncios, observacoes, quarentena e
  acesso/retencao.
- Migrar `media_download_states` e `media_availability_manifests` do
  `LocalStorage` de modo idempotente.
- Tratar manifestos v1 importados como legado nao confiavel para roteamento ate
  que o peer publique um anuncio v2 valido.
- Manter os dados antigos quando a migracao falhar e nao considerar o storage
  pronto ate concluir a transacao de upgrade.
- Normalizar binarios, datas, inteiros, IDs, hashes e enums ao carregar dados.

### Plano de execucao

#### 15.5.1 - Consolidar o caminho de producao

1. Inventariar consumidores de `MediaTransferService`, `ChunkService`,
   `MediaProtocol` e `ChunkProtocol`.
2. Manter `MediaService` para ingestao local e `PeerMediaSyncService` para
   transferencia P2P como caminhos oficiais.
3. Migrar consumidores ainda ativos e remover getters/runtime de implementacoes
   somente em memoria.
4. Marcar qualquer compatibilidade temporaria com tipo e log de depreciacao
   explicitos, sem fallback silencioso.

Status: concluido em 2026-07-29.

- `MediaService` agora possui somente ingestao e leitura local validada.
- `PeerMediaSyncService` permanece como o unico caminho de transferencia P2P.
- O runtime e `AppService` nao expoem mais o cache em memoria legado.
- `MediaTransferService`, `ChunkService`, `MediaTransport`, `MediaProtocol`,
  `ChunkProtocol` e `NetworkMessageCodec` foram removidos depois da confirmacao
  de que nao possuissem consumidores reais.
- Health de storage e transporte passou a derivar apenas de repositories e do
  transport WebRTC reais.
- `rg` confirmou ausencia de referencias aos contratos removidos.

Validacao:

- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test -- --runInBand`: 60 suites e 291 testes aprovados.
- `npx.cmd expo export --platform web`: export web concluido.

#### 15.5.2 - Persistencia e migracao

1. Criar repositories tipados para download, disponibilidade, saude de fonte e
   quarentena.
2. Implementar a migracao v8 para v9 em IndexedDB e equivalente nativo.
3. Importar os dois registros antigos de `LocalStorage` uma unica vez.
4. Restaurar jobs interrompidos sem apagar chunks ja validados.
5. Tornar gravacao de chunk, progresso e cursor recuperavel: o job so confirma
   um chunk depois de sua persistencia e validacao.

Status: concluido em 2026-07-29 para jobs e disponibilidade persistentes.

- O banco web foi migrado da versao 8 para a versao 9 sem destruir os stores
  anteriores.
- O schema v9 cria `media_download_jobs`,
  `media_availability_announcements`, `media_replica_observations`,
  `media_quarantine_records` e `media_access_records` com indices explicitos.
- O caminho SQLite nativo cria as mesmas tabelas de modo idempotente. Jobs e
  anuncios ja possuem repository tipado ativo; observacoes, quarentena e
  retencao ficam reservadas para as politicas dos blocos 15.5.4 e 15.5.6.
- `MediaDownloadRepository` valida todos os registros carregados, rejeita schema
  ou JSON corrompido e nunca injeta dados invalidos no runtime.
- `media_download_states` e `media_availability_manifests` sao importados do
  `LocalStorage` em uma unica transacao. As chaves antigas so sao removidas
  depois do commit; falha ou corrupcao preserva o legado para recuperacao.
- Um registro persistido mais novo prevalece sobre o legado, tornando a
  migracao idempotente em reloads e inicializacoes concorrentes.
- `PeerMediaSyncService` persiste estados antes de emitir atualizacoes para a
  UI, serializa checkpoints concorrentes e restaura jobs `downloading`,
  `partial` e `failed` depois do bootstrap.
- A retomada consulta os chunks ja persistidos e solicita somente os ausentes.
  O estado `available` continua exigindo a validacao final do objeto completo.
- Falhas de bootstrap de disponibilidade ou retomada sao registradas de forma
  estruturada, sem promessa rejeitada solta.
- O teste E2E revelou que `peer_connect_failed` recuperavel abria o overlay de
  desenvolvimento e bloqueava a navegacao. O evento passou a `warn`, mantendo o
  erro seguro no card do peer.
- Manifestos v1 importados continuam em modo de compatibilidade nesta etapa. A
  assinatura, expiracao, sequencia e exclusao de v1 do roteamento pertencem ao
  bloco 15.5.4.

Validacao:

- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test -- --runInBand`: 61 suites e 299 testes aprovados.
- `npm.cmd run test:e2e:mesh:repeat`: 9 cenarios aprovados em tres repeticoes
  depois da correcao de duas flutuacoes detectadas pela primeira execucao.
- `npx.cmd expo export --platform web`: export web concluido.

#### 15.5.3 - Integridade e retomada

1. Centralizar SHA-256 e validacao estrutural em `MediaIntegrityService`.
2. Validar chunks locais durante o bootstrap antes de conta-los como completos.
3. Remover somente o chunk local corrompido e retomar pela primeira posicao
   ausente ou invalida.
4. Exigir correspondencia entre ID, hash, posicao, tamanho, objeto e manifesto.
5. Marcar `available` somente depois do hash final do objeto remontado.
6. Limitar partes pendentes por mensagem, peer, objeto, bytes e TTL.

Status: concluido em 2026-07-29.

Implementacao:

- `MediaIntegrityService` passou a ser a fronteira unica para hash SHA-256,
  identificador deterministico, normalizacao binaria, validacao de chunks,
  manifesto, remontagem e hash final do objeto.
- O runtime compartilha a mesma instancia do servico entre ingestao local e
  sincronizacao P2P.
- O bootstrap audita a midia persistida antes do anuncio de disponibilidade,
  remove apenas chunks comprovadamente invalidos e mantem os demais para
  retomada.
- Downloads validam peer, correlacao, objeto, ID, posicao, tamanho e hash antes
  da persistencia. Respostas nao solicitadas ou vinculadas ao peer errado sao
  rejeitadas.
- O estado `available` somente e emitido depois da remontagem e verificacao do
  tamanho e hash final.
- Transferencias multipart possuem limites explicitos de mensagens, partes por
  mensagem, partes por peer, partes por objeto, bytes globais, bytes por peer,
  bytes por objeto e TTL. `stop()` e timeout liberam requests e partes.
- A codificacao base64 deixou de depender de casts globais inseguros e entradas
  malformadas sao rejeitadas antes da remontagem.

Validacao:

- `npm.cmd run lint`: aprovado.
- `npm.cmd run typecheck`: aprovado.
- `npm.cmd test -- --runInBand`: 62 suites e 318 testes aprovados.
- `npm.cmd run test:e2e:mesh`: 3 cenarios aprovados.
- `npx.cmd expo export --platform web`: export web concluido.
- A repeticao tripla da matriz e os cenarios especificos de corrupcao remota,
  replica alternativa e reparo permanecem no Bloco 15.5.7.

#### 15.5.4 - Disponibilidade, selecao e quarentena

1. Criar serializacao canonica e assinatura do anuncio v2.
2. Validar emissor, assinatura, sequencia, expiracao, limites e chunks antes de
   persistir.
3. Paginar anuncios grandes para permanecer abaixo do limite de mensagem.
4. Expirar observacoes antigas sem apagar chunks locais.
5. Selecionar fonte por chunk e registrar resultado depois de cada tentativa.
6. Colocar a combinacao peer/objeto/chunk em quarentena apos corrupcao
   comprovada; a quarentena e local, expiravel e nao altera trust global.
7. Tentar imediatamente a proxima fonte integra sem reiniciar o objeto.

Status: concluido em 2026-07-31.

Implementacao:

- `MediaAvailabilityAnnouncementV2` possui emissor, sequencia monotona, emissao,
  expiracao, pagina, itens e assinatura Ed25519 da identidade local.
- `MediaAvailabilityService` usa serializacao canonica, limita TTL, clock skew,
  itens, chunks e bytes por pagina, e rejeita remetente divergente, assinatura
  invalida, replay, conflito, expiracao e sequencia antiga.
- Anuncios grandes sao paginados antes do envio. Todas as paginas compartilham
  a mesma sequencia assinada e permanecem abaixo do limite reservado para o
  envelope de rede.
- O bootstrap revalida criptograficamente anuncios recuperados do storage. Um
  registro adulterado e removido antes de poder influenciar o roteamento.
- A persistencia preserva um cabecalho expirado da ultima sequencia por peer
  somente para monotonicidade; itens expirados nunca entram na selecao.
- Manifestos v1 continuam legiveis para migracao e diagnostico, mas nao servem
  mais como prova de disponibilidade nem retomam downloads.
- `media_replica_observations` e `media_quarantine_records` passaram a ter APIs
  tipadas no repository e persistem sucesso, falha, latencia, evidencia,
  expiracao e contagem de corrupcoes no IndexedDB/SQLite.
- `MediaSourceSelector` ordena fontes de forma deterministica usando anuncio
  fresco, historico persistido, latencia e ID do peer como desempate.
- Uma resposta de chunk com base64, metadados, hash, ID, posicao, tamanho ou
  objeto invalidos coloca apenas a combinacao peer/objeto/chunk em quarentena.
- Depois da corrupcao, o download tenta a proxima fonte integra e preserva todos
  os chunks previamente validados.

Validacao:

- `npm.cmd run verify`: aprovado; secret scan, lint, typecheck, 64 suites e 328
  testes, e export web concluidos.
- `npm.cmd run test:e2e:mesh:repeat`: 9 cenarios aprovados em 5,9 minutos, com
  tres repeticoes isoladas da malha A-B-C-D.
- Os testes novos cobrem assinatura, adulteracao, expiracao, replay, sequencia,
  paginacao, reabertura do IndexedDB, selecao deterministica, quarentena e
  failover de uma replica corrompida para uma integra.
- Corrupcao remota e reparo automatico ainda precisam entrar na matriz
  Playwright especifica dos blocos 15.5.6 e 15.5.7.

#### 15.5.5 - Transporte e backpressure

1. Substituir o tamanho fixo de partes por um calculo que inclua base64 e o
   envelope JSON, garantindo frame abaixo de `MAX_NETWORK_MESSAGE_BYTES`.
2. Introduzir uma fila por peer e aguardar `bufferedamountlow` antes de continuar
   o envio.
3. Limitar objetos, chunks, partes e bytes simultaneos por peer.
4. Cancelar e liberar pending parts, listeners e timers em timeout, disconnect e
   `stop()`.
5. Diferenciar timeout, indisponibilidade, corrupcao, cancelamento e storage
   cheio com erros tipados.

Status: concluido em 2026-07-31.

Implementacao:

- `MediaTransferScheduler` mantem uma fila independente por peer, ordenada por
  prioridade e sequencia, sem permitir crescimento ilimitado de frames, bytes,
  objetos ou chunks pendentes.
- O scheduler consulta uma capacidade opcional de flow control do
  `PeerConnection`. No WebRTC, ele observa `bufferedAmount`, configura
  `bufferedAmountLowThreshold` e aguarda `bufferedamountlow` antes do proximo
  envio; um peer bloqueado nao paralisa as filas dos demais.
- Listeners e timers da espera sao liberados em sucesso, timeout, cancelamento,
  desconexao e `stop()`. O cancelamento de um objeto tambem encerra requests e
  partes pendentes daquele download.
- O tamanho bruto de cada parte e calculado por busca binaria sobre o frame
  completo: envelope versionado, metadados JSON, correlation ID, base64 e bytes
  UTF-8. O corte fixo de 64 KiB foi removido.
- `NetworkMessage` e `WebRtcPeerTransport` passaram a medir tamanho em bytes
  UTF-8, evitando que texto multibyte ultrapasse silenciosamente o limite.
- Timeout, peer indisponivel, corrupcao, cancelamento, storage cheio,
  backpressure e frame excessivo possuem classificacao tipada por
  `MediaTransferError` e mensagens seguras distintas.
- O caminho de envio de anuncios, requests, respostas e partes usa o scheduler.
  Transferencia parcial nao e mais registrada como resposta dividida completa.
- O health do runtime usa a quantidade real de frames de midia pendentes em
  `transports.pendingMessages`; o snapshot do scheduler tambem expoe bytes em
  voo, peers bloqueados, esperas, envios, rejeicoes e cancelamentos.

Validacao:

- Teste integrado com frame configurado em 24 KiB comprovou que um chunk grande
  foi dividido e que todas as partes permaneceram abaixo desse teto.
- Testes unitarios cobrem UTF-8, base64, fila limitada, prioridade, isolamento
  entre peers, `bufferedamountlow`, cancelamento, cleanup e erro de frame.
- `npm.cmd run verify`: aprovado; secret scan, lint, typecheck, 65 suites e 335
  testes, e export web concluidos.
- `npm.cmd run test:e2e:mesh:repeat`: 9 cenarios aprovados em 5,8 minutos, com
  tres repeticoes isoladas da malha A-B-C-D.
- Suspensao real de aba, variacao de throughput e TURN continuam dependentes do
  teste externo entre computadores previsto no Bloco 15.8.

#### 15.5.6 - Reparacao, retencao e runtime

1. Calcular replica fresca apenas por anuncio v2 valido e nao expirado.
2. Quando abaixo de `minReplicas`, oferecer uma replica a peers verificados com
   quota; confirmar somente depois do download e novo anuncio assinado.
3. Executar reparo em fila com backoff, sem loop periodico ruidoso.
4. Proteger uploads locais, downloads ativos, midia aberta recentemente e a
   ultima replica conhecida durante GC.
5. Ordenar descarte por politica explicita: invalido/orfao, expirado, sem
   referencia, baixa disponibilidade externa, ultimo acesso e tamanho.
6. Expor health real: jobs ativos, bytes pendentes, replicas, quarentenas,
   frames bloqueados e ultimo reparo.
7. Atualizar feed e inspector somente por subscriptions do runtime.

Status: concluido em 2026-07-31.

Implementacao:

- `MediaRepairService` identifica objetos locais completos abaixo de
  `minReplicas`, oferece replicas somente a peers conectados e verificados e
  executa novas tentativas em fila com backoff, sem polling periodico.
- Uma oferta enviada permanece pendente. O reparo so e confirmado depois que o
  receptor publica um anuncio v2 assinado, fresco, paginado por completo e com
  exatamente todos os chunks do manifesto.
- `media.replica.offer` usa o transporte P2P existente e respeita confianca,
  quota local e backpressure. Ofertas expiradas, futuras, sem objeto conhecido
  ou acima da quota sao rejeitadas sem anunciar disponibilidade incompleta.
- `MediaDownloadRepository` persiste ultimo acesso e protecao explicita em
  `media_access_records`, reconstrui esses dados ao reabrir o IndexedDB e calcula
  replicas completas sem aceitar manifestos v1, paginas ausentes ou expiradas.
- A limpeza protege uploads locais, downloads ativos, midia aberta recentemente,
  itens protegidos pelo usuario e a ultima replica local conhecida. Objetos
  descartaveis sao ordenados por referencia, disponibilidade externa, ultimo
  acesso e tamanho.
- Chunks vinculados corrompidos e chunks orfaos sao removidos por validacao de
  integridade. O registro de acesso correspondente tambem e eliminado quando o
  objeto deixa o cache.
- O runtime inicia o reparador somente depois de validar integridade local e
  anuncios persistidos, encaminha eventos aceitos de disponibilidade e libera
  subscriptions, filas e timers em `stop()` e reset.
- `RuntimeHealthSnapshot.media` expoe jobs e downloads ativos, replicas frescas,
  quarentenas, frames e bytes pendentes, peers bloqueados, reparos pendentes,
  objetos sub-replicados e ultimo reparo usando dados reais.
- Feed e inspector registram acesso real; o inspector deixou de consultar o
  runtime a cada cinco segundos e agora atualiza por subscription coalescida.

Validacao:

- Testes de repository cobrem persistencia e limpeza de acesso, reabertura do
  IndexedDB e confirmacao de replica paginada apenas com todas as paginas.
- Testes de retencao cobrem upload local, download ativo, acesso recente, ultima
  replica conhecida, preferencia por objeto replicado e chunk corrompido.
- Testes de reparo cobrem oferta abaixo do minimo, confirmacao por anuncio v2
  completo, ausencia de oferta no minimo, backoff e cleanup do lifecycle.
- Testes P2P cobrem download disparado por oferta e recusa recuperavel quando a
  quota local esta cheia.
- `npm.cmd run verify`: aprovado; secret scan, lint, typecheck, 66 suites e 345
  testes, e export web concluidos.
- `npm.cmd run test:e2e:mesh:repeat`: 9 cenarios aprovados em 6,0 minutos, com
  tres repeticoes isoladas da malha A-B-C-D.
- Corrupcao remota, reparo automatico e metricas de bytes ainda precisam entrar
  na matriz Playwright especifica do Bloco 15.5.7.

#### 15.5.7 - Validacao e remocao do legado

1. Remover classes e protocolos legados depois que `rg`, typecheck e testes
   provarem ausencia de consumidores.
2. Executar testes unitarios, repository/IndexedDB, integracao WebRTC e matriz
   E2E A-B-C-D.
3. Repetir a matriz tres vezes com databases e identidades isoladas.
4. Confirmar no signaling que nenhum byte de arquivo, chunk ou preview foi
   enviado ou persistido.
5. Medir bytes enviados, retomados, descartados, reparados e liberados pelo GC.

### Testes obrigatorios do bloco

#### Unitarios

- Mesmo arquivo produz o mesmo manifesto, objeto, chunks e hashes.
- Chunk adulterado falha antes da persistencia.
- Posicao duplicada, ausente ou fora da faixa invalida o objeto.
- Anuncio expirado, adulterado, fora de sequencia ou com assinatura invalida e
  rejeitado.
- Selecao de origem e deterministica e ignora fonte em quarentena.
- Calculo de frame considera bytes UTF-8, base64 e envelope completo.
- GC preserva download ativo, midia protegida e ultima replica conhecida.

#### Integracao

- Migracao v8 para v9 preserva jobs e importa o estado legado uma vez.
- Falha de migracao nao apaga os registros antigos.
- Reload valida chunks existentes e retoma no primeiro chunk ausente.
- Corrupcao local remove somente o chunk invalido.
- Corrupcao remota penaliza a origem e conclui por uma segunda replica.
- Disconnect libera partes pendentes e o job continua apos reconexao.
- Quota cheia produz estado recuperavel e nao anuncia uma replica incompleta.
- Anuncio novo substitui sequencia anterior; replay nao prolonga sua validade.

#### E2E A-B-C-D

- A publica uma imagem; B e C formam replicas; A sai; D baixa por B ou C.
- B devolve um chunk corrompido; D rejeita B e conclui por C.
- D recarrega no meio do download e nao solicita novamente chunks validos.
- Uma replica e removida e o reparador restaura `minReplicas`.
- Todos os peers exibem `available` apenas depois da verificacao final.
- O servidor de signaling observa somente mensagens efemeras de conexao.

### Criterios de aceite

- D baixa a midia depois que A sai, usando B ou C.
- A primeira replica pode devolver um chunk corrompido e D conclui pela segunda.
- Reload durante download preserva chunks validos e retoma o restante.
- A UI marca a midia como disponivel somente apos validar o objeto completo.
- Nenhum chunk e enviado ao servidor de signaling.
- Anuncios expirados ou sem assinatura valida nao influenciam a selecao.
- Nenhum frame excede o limite do protocolo ou cresce sem backpressure.
- O reparo confirma o fator de replica por anuncios assinados, nao por contador
  local inventado.
- GC nao remove a ultima replica conhecida nem um download ativo.

### Gates do bloco

```bash
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test -- --runInBand
npm.cmd run test:e2e:mesh:repeat
npx.cmd expo export --platform web
```

O teste externo com dois computadores continua necessario para validar
throughput, suspensao de aba e comportamento em redes reais; ele nao pode ser
substituido apenas pela matriz local.

## Bloco 15.6 - Seguranca de sessao e resistencia a abuso

- [ ] Vincular o handshake assinado ao `sessionId` e ao transcript da negociacao.
- [ ] Persistir protecao contra replay para mensagens e sinais autenticados.
- [ ] Bloquear mudanca inesperada de chave para um peer conhecido.
- [ ] Validar origem, versao, assinatura, TTL, tamanho e destinatario antes do handler.
- [ ] Aplicar quotas por peer para mensagens, sync, chunks e negociacoes.
- [ ] Limitar fan-out, saltos e retransmissoes para evitar amplificacao.
- [ ] Aplicar rate limit no signaling sem armazenar conteudo social.
- [ ] Exigir WSS e configuracao segura fora do ambiente local.
- [ ] Permitir bloquear e colocar peer abusivo em quarentena.
- [ ] Documentar o modelo de ameacas e as limitacoes do navegador.

### Criterios de aceite

- Replay, mensagem expirada e assinatura invalida sao rejeitados antes do dominio.
- Um peer bloqueado nao inicia sessao, sync, relay ou download.
- Uma tempestade de offers nao cria crescimento ilimitado de PeerConnections.
- O cliente distribuido nao contem chave administrativa do signaling ou TURN.

## Bloco 15.7 - Observabilidade e UX operacional

- [ ] Agregar health de signaling, ICE, sessao, sync, outbox, relay e midia.
- [ ] Expor caminho direto ou relay sem mostrar informacoes privadas de rede.
- [ ] Mostrar `conectando`, `online`, `reconectando`, `offline` e `bloqueado`.
- [ ] Mostrar fila pendente, ultima sincronizacao e motivo seguro de falha.
- [ ] Exibir entrega de chat como enviada, em relay, entregue, lida ou expirada.
- [ ] Permitir retry apenas para operacoes realmente recuperaveis.
- [ ] Disponibilizar exportacao de diagnostico sanitizado no Developer Mode.
- [ ] Manter ferramentas de developer fora da navegacao principal.
- [ ] Substituir logs periodicos repetidos por eventos de transicao de estado.
- [ ] Adicionar contadores de rejeicao sem payload ou identificador sensivel.

### Criterios de aceite

- O usuario entende se a falha e de Internet, peer offline ou sincronizacao.
- O diagnostico permite investigar uma sessao sem revelar mensagens ou chaves.
- Estado de UI deriva do runtime e atualiza sem reload ou polling duplicado.
- Periodos offline normais nao geram warnings repetidos indefinidamente.

## Bloco 15.8 - Validacao externa, migracao e release

- [ ] Versionar mudancas de outbox, checkpoints, tombstones e disponibilidade.
- [ ] Criar migracoes idempotentes com teste de falha e recuperacao.
- [ ] Cobrir regras puras com testes unitarios.
- [ ] Cobrir IndexedDB, reload e retomada com testes de integracao.
- [ ] Executar a matriz A-B-C-D com particao, conflito, relay offline e corrupcao.
- [ ] Repetir a matriz completa pelo menos tres vezes sem estado compartilhado.
- [ ] Testar dois computadores em redes e provedores diferentes.
- [ ] Testar conexao direta e conexao forcada por TURN.
- [ ] Confirmar que o signaling termina sem conteudo social persistido.
- [ ] Medir crescimento de sessoes, filas, recibos, tombstones e cache.
- [ ] Documentar configuracao, operacao, rollback e riscos restantes.

### Gates obrigatorios

```bash
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test -- --runInBand
npm.cmd run test:e2e:mesh:repeat
npx.cmd expo export --platform web
```

Scripts adicionais so devem ser executados quando existirem no `package.json`.

## Ordem de execucao

1. Bloco 15.1: tornar falhas reproduziveis e mensuraveis.
2. Bloco 15.3: provar entrega duravel antes de adicionar novas rotas de Internet.
3. Bloco 15.4: fechar convergencia de estado sob particao.
4. Bloco 15.5: concluir reparacao automatica de midia.
5. Bloco 15.2: integrar ICE/TURN e validar redes externas.
6. Bloco 15.6: executar hardening contra peers e sinais hostis.
7. Bloco 15.7: apresentar os novos estados de forma clara na interface.
8. Bloco 15.8: migrar, validar repetidamente e documentar operacao.

O Bloco 15.2 pode ser desenvolvido em paralelo depois que o controlador de falhas
do Bloco 15.1 estiver estavel, mas nao deve alterar as regras de dominio.

## Fora de escopo

- Armazenar feed, chat, perfis ou arquivos no Supabase.
- Transformar signaling em API social ou fila duravel de mensagens.
- Criar VPN, blockchain ou servidor federado.
- Reescrever o projeto em Rust ou trocar Expo/React Native.
- Notificacoes push com o app completamente encerrado.
- Moderacao global e descoberta publica em escala de Internet.
- Garantir disponibilidade quando nenhum peer com a informacao estiver online.

## Riscos

- TURN consome banda e exige operacao ou provedor com limites e custos claros.
- Browsers suspendem abas e nao garantem trabalho continuo em background.
- IndexedDB pode ser removido por politica de quota ou pelo usuario.
- Relays preservam conteudo cifrado, mas ainda observam metadados de trafego.
- Tombstones e outbox sem limites podem crescer indefinidamente.
- Relogios adulterados exigem revisoes assinadas e desempate independente de tempo.
- Redes corporativas podem bloquear WebRTC mesmo com configuracao correta.
- Mobile exigira estrategia propria de background e notificacao em fase posterior.

## Definicao de concluido

A Phase 15 estara concluida quando:

- A malha A-B-C-D convergir depois de particoes e conflitos sem reload manual.
- Chat pendente sobreviver a reload e indisponibilidade temporaria dos relays.
- Midia trocar automaticamente de uma replica corrompida para uma integra.
- Dois computadores em redes distintas conectarem por rota direta ou TURN.
- Nao houver sessoes duplicadas, full sync desnecessario ou crescimento ilimitado.
- Todos os dados externos forem validados e todas as operacoes forem idempotentes.
- Os gates locais, E2E repetidos e a matriz externa passarem.
- As limitacoes de background, disponibilidade e metadados estiverem documentadas.

Mesmo com esses criterios atendidos, a classificacao para producao dependera de
teste de carga, auditoria de seguranca, operacao de TURN e validacao mobile.
