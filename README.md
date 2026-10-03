# STEP Painel Operacional Remodelado

Painel operacional independente da STEP para substituir gradualmente o Tracking como fonte operacional, sem quebrar os projetos em andamento.

## Estado atual

A V1 real está na branch `feature/operational-panel-v1`.

O painel trabalha em modo híbrido por BSP:

- `legacy_tracking`: a BSP ainda usa o snapshot normalizado do Tracking e permanece somente leitura no novo fluxo;
- `ops_core`: a BSP foi validada e passa a usar exclusivamente o núcleo operacional próprio;
- o cutover é individual, auditado e reversível.

Nenhuma BSP é retirada do Tracking automaticamente. O corte ocorre somente após validação na tela **Cadastro**.

## Núcleo operacional

O schema `ops_core` no Supabase contém:

- projetos e aliases de BSP/BEP/BPP/B3D/SP;
- itens e aliases de ISO/spool/support/structure;
- documentos e histórico de revisões;
- proteção contra downgrade de revisão;
- proveniência por campo;
- workflow por etapa;
- eventos imutáveis;
- handoffs entre setores;
- notificações;
- fila de candidatos e validação;
- mapa de IDs legados;
- auditoria de alterações;
- preservação de QR Codes.

As migrations aplicadas em produção estão versionadas em `supabase/migrations/`.

## Fontes

Após o cutover, o Tracking não é mais fonte da BSP.

O núcleo combina:

- WIP / Job Order: dados de projeto, PO e datas;
- Drawing Documentation / FCB: documentos, revisões e requisitos técnicos;
- STEP Flow: suprimentos;
- Apontamento HH: execução, HH e fotos;
- 3D / Dimensional: inspeções e simulações;
- Logística: movimentações e expedição;
- OPS CORE: identidade, estado atual, workflow, handoffs e auditoria.

O Tracking permanece apenas como fonte temporária para BSPs ainda não validadas e como histórico de migração.

## Workflow

As etapas são configuradas em `ops_core.workflow_stages`.

Etapas de execução dependentes do apontador, como Caldeiraria, Solda e Pintura, não podem ser concluídas manualmente pelo painel. O backend rejeita esse avanço e exige o registro pelo Apontamento HH.

Etapas manuais ou de integração podem ser assumidas, bloqueadas, retomadas e concluídas pelo setor autorizado. Ao concluir uma etapa, o backend abre automaticamente o próximo handoff e gera a notificação do setor seguinte.

## Revisões

O sistema mantém documento e revisão como entidades separadas.

- revisão superior vira vigente;
- revisão anterior permanece histórica;
- revisão inferior recebida depois de uma superior é armazenada, mas não substitui a vigente;
- alteração de conteúdo na mesma revisão fica pendente de conferência;
- mudanças técnicas são auditadas e associadas à fonte/revisão.

## Segurança

- tabelas `ops_core` usam RLS;
- o navegador não recebe service role;
- mutações passam pela Edge Function autenticada;
- usuário só pode atuar no setor compatível com a etapa, salvo perfis administrativos;
- o ambiente Netlify isolado exige login da equipe;
- o backend mantém auditoria de ações e fontes.

## Deploy

### Supabase

Edge Function:

`ops-panel-api`

A função é publicada com autenticação própria do painel e está integrada à sessão STEP.

### Netlify

Projeto isolado:

`step-painel-operacional`

O frontend usa a Edge Function autenticada do Supabase diretamente no ambiente isolado.

### STEP One

A integração definitiva continua preparada para ser feita pelo card **Operações & Projetos** da Intranet, preservando SSO e sem segundo login quando promovida ao ambiente oficial.

## Validação antes do cutover

Uma BSP só pode ser promovida para `ops_core` quando:

1. possuir itens;
2. todos os itens possuírem workflow;
3. não existirem itens provisórios originados apenas de quantidade documental;
4. divergências críticas de cadastro forem resolvidas;
5. o operador validar o cadastro na tela **Cadastro**.

Campos técnicos faltantes aparecem como aviso e permanecem rastreáveis para conferência.

## Testes

O workflow **Validate Operational Panel** executa instalação, typecheck e build a cada push da branch V1.

O motor de handoff também foi validado em transação com rollback:

- aceitar etapa manual;
- concluir etapa;
- criar handoff;
- bloquear conclusão manual em etapa controlada pelo Apontamento HH;
- rollback sem alterar dados reais.
