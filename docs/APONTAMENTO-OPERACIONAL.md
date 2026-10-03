# Apontamento como fonte operacional

## Objetivo

O Tracking permanece como cadastro, planejamento e sequência oficial das etapas. O Apontamento HH passa a ser a fonte de execução real para o painel operacional.

O painel não deve criar um setor PCP artificial. As filas visíveis são Engenharia, Suprimentos, Caldeiraria, Solda, Qualidade, Pintura e Expedição. ON HOLD é status, não setor.

## Fluxo

1. O Tracking define BSP/ISO/SPL, etapas aplicáveis e planejamento.
2. O apontador seleciona BSP/ISO e a atividade.
3. Ao iniciar, o HH registra sessão, equipe, data/hora, foto inicial e etapa do Tracking associada.
4. Durante a execução, os avanços 25/50/75 são gravados em hh_sessions.
5. O painel lê a sessão aberta e usa o HH como estado real da execução.
6. Ao finalizar como concluído, o HH registra 100%, foto final, HH total e data/hora.
7. A conclusão gera uma intenção de atualização do Tracking.
8. Um bridge server-side valida idempotência, versão do Tracking, coluna-alvo e permissões antes de escrever no Smartsheet.
9. Depois da escrita, a normalização oficial do Tracking confirma o resultado e o painel passa a refletir a etapa seguinte.

## Mapeamento existente

O banco já contém tracking_iso_stages com:
- stage_key
- stage_order
- progress
- source_progress_column
- source_actual_column

O HH já contém progress_stage_key. Esse campo usa o nome da coluna de progresso do Tracking, permitindo o vínculo sem depender somente do nome da atividade.

Exemplos:
- Spool Assemble and tack weld -> preassembly
- Full welding execution -> welding
- Final Dimensional Inpection/3D (QC) -> scan-final
- Hydro Test Pressure (QC) -> hydro
- Surface preparation and/or coating -> painting

## Segurança da escrita no Tracking

A escrita não deve acontecer diretamente pelo navegador nem pelo app offline. O HH grava primeiro no Supabase. Um outbox idempotente será responsável por enviar alterações ao Smartsheet.

Campos mínimos do futuro outbox:
- session_id
- project_row_id
- iso_key
- tracking_stage_key
- source_progress_column
- source_actual_column
- requested_progress
- requested_actual_date
- source_event_id / dedup_key
- status
- attempts
- last_error
- created_at / processed_at

O processamento deve rejeitar:
- linha de Tracking não encontrada;
- etapa não aplicável;
- tentativa de reduzir progresso sem regra explícita;
- versão incompatível quando houver risco de sobrescrever edição humana;
- sessão cancelada;
- evento duplicado.

## Estado atual implementado

Foi criada uma camada read-only ops_panel.hh_execution_current. Ela não altera hh_sessions. O painel recebe a sessão HH mais recente por BSP/ISO e, quando há sessão aberta, usa atividade, etapa, progresso, equipe e horário do Apontamento como execução real.

A escrita de volta no Smartsheet ainda deve ser ativada somente depois de validar a matriz etapa -> coluna com casos reais.
