# Arquitetura V1 · STEP Operational Flow

## Objetivo

Criar um painel operacional orientado por fila de trabalho. Cada demanda precisa ter um setor atual, uma etapa atual, um responsável opcional, um relógio de entrada/SLA e um próximo destino.

## Princípio de isolamento

- O aplicativo de Apontamento HH permanece intocado.
- As tabelas `public.hh_*` são tratadas como fonte somente leitura.
- O frontend não possui métodos de escrita em HH.
- O painel funciona sem Supabase usando dados simulados.
- A proposta de banco `ops` está em `supabase/proposals`, não em `supabase/migrations`.
- Nenhum SQL deste repositório deve ser executado no banco operacional sem revisão separada.

## Fonte HH existente

O adaptador `src/services/hhReadOnly.ts` consulta somente `hh_sessions`, aproveitando:

- BSP e ISO;
- atividade atual;
- status da sessão;
- início/fim;
- duração/HH;
- responsável do apontamento;
- status de encerramento.

A evolução prevista inclui consulta de `hh_session_photos` para mostrar evidências, ainda sem duplicar arquivos.

## Caixa por setor

A tela principal é `Minha Caixa`.

Uma demanda pertence à caixa quando `current_sector_id` aponta para o setor do usuário. A visualização é separada em:

- novas;
- em execução;
- aguardando;
- bloqueadas;
- atrasadas;
- concluídas;
- próximas para o setor.

`Próximas` não significa que a demanda já mudou de dono. É uma previsão baseada no próximo setor configurado no workflow.

## Handoff

Fluxo alvo:

1. setor A conclui a etapa;
2. é criado evento `stage.completed`;
3. é criado um handoff;
4. a demanda passa para a caixa do setor B;
5. o setor B recebe notificação;
6. opcionalmente um membro aceita a demanda;
7. o relógio de fila/SLA passa a ser rastreado.

A política poderá ser `auto_assign` ou `require_acceptance` por etapa.

## Integração com Apontamento

Atividades do chão de fábrica devem poder mapear para etapas do workflow. Mapeamento inicial:

- `fitup` -> Caldeiraria;
- `montagem` -> Caldeiraria;
- `solda` -> Solda;
- `inspecao` -> Qualidade;
- `hydro_test` -> Qualidade;
- `pintura` -> Pintura;
- `reparo`, `suporte`, `retrabalho` -> configurável, inicialmente Caldeiraria.

A regra real não deve ficar hardcoded definitivamente. Na fase de persistência, o mapeamento deverá ir para configuração do workflow.

## Fotos

Para atividades executadas pelo Apontamento, a evidência permanece no armazenamento/tabelas atuais do HH. O painel operacional referencia a sessão e consulta as evidências.

Para etapas de outros setores, a política será configurável:

- `required_start_finish`;
- `optional`;
- `none`.

## Notificações

Eventos previstos:

- `stage.started`;
- `stage.progress_changed`;
- `stage.completed`;
- `handoff.created`;
- `handoff.accepted`;
- `demand.blocked`;
- `demand.unblocked`;
- `sla.warning`;
- `sla.breached`;
- `rework.opened`.

A arquitetura proposta utiliza `ops.events` + `ops.notifications` + `ops.outbox`. A outbox permite retry e deduplicação sem depender apenas de Realtime.

## Próximas fases

1. validar visual/fluxo com Operação, Qualidade e PCP;
2. definir os workflows reais e transições;
3. revisar autenticação/permissões do STEP One;
4. revisar SQL `ops` e RLS;
5. criar funções transacionais de handoff/aceite/bloqueio;
6. conectar leitura HH real;
7. somente depois integrar o módulo ao STEP One.
