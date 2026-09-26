# Hub de Dados do Painel Operacional

## Objetivo

O painel não consulta várias planilhas Smartsheet a cada abertura. As fontes são consolidadas no Supabase operacional e o frontend consulta uma camada única de leitura.

Fluxo:

```
Smartsheet / caches existentes
        ↓
ops-panel-sync
        ↓
schema ops_panel
        ↓
ops-panel-api
        ↓
backend autenticado STEP One
        ↓
Painel Operacional
```

## Fontes principais

| Chave | Origem | Sheet ID | Estratégia |
| --- | --- | ---: | --- |
| tracking | Progress Tracking Sheet - Piping Fabrication | 3612820139992964 | Reutiliza public.tracking_* |
| wip | WORK-IN-PROGRESS - STEP | 1393515847542660 | Sincronização incremental por versão |
| job_order | JOB_ORDER-StepBr(NEW) | 3352070687352708 | Reutiliza public.po_mgmt_* |
| drawing | DRAWING DOCUMENTATION CONTROL | 2580648465590148 | Sincronização + revisões dinâmicas |
| dimensional | 3D Dimensional Control | 1968635389470596 | Sincronização e vínculo múltiplo por BSP |
| logistics | PROGRAMAÇÃO GERAL - LOGISTICA DE MATERIAIS | 4690595134001028 | Sincronização por BSP |
| production_pt_2026 | Production Progress PT 2026 - Timeline... | 2376307238195076 | Sincronização de produção Portugal |

Material Master List foi analisado, mas não foi incorporado à carteira porque não possui chave BSP/projeto confiável.

## Drawing e FCB

O Drawing é importado sem limitar as revisões a A-F. O sincronizador detecta colunas no padrão `(Rev. X)` e cria dinamicamente o array de revisões. Se a planilha ganhar Rev. G, H etc., a nova revisão passa a ser importada sem alteração de schema.

São preservados, quando existentes:

- desenhista e HH;
- reviewer e HH;
- approver e HH;
- aprovações;
- envio interno ao PM;
- aprovação do PM;
- origin review;
- comentários do cliente;
- datas de início/atualização;
- raw das colunas de revisão.

FCB é detectado pelo conteúdo real das células. O Drawing e o 3D Dimensional Control são mantidos como fontes diferentes para não confundir documento de engenharia com laudo/inspeção.

## Histórico

`ops_panel.source_rows` guarda a versão atual de cada linha.

Quando o hash de uma linha muda, a versão anterior é copiada para `ops_panel.source_row_history` antes da atualização. Isso permite rastrear alterações e revisões sem modificar o Smartsheet original.

## Chaves com múltiplos BSPs

Algumas linhas do 3D possuem vários projetos em uma mesma célula. A função `ops_panel.extract_project_keys` extrai cada BSP válido e cria vínculos independentes na visão normalizada. O valor bruto permanece preservado.

## Sincronização

O cron `ops-panel-smartsheet-sync-15m` roda a cada 15 minutos.

Antes de baixar uma planilha, a Edge Function consulta `/sheets/{id}/version`. Se a versão não mudou, a fonte é marcada como `unchanged` e nenhuma carga completa é feita.

Tracking e Job Order continuam usando seus sincronizadores já existentes para evitar duplicação e consumo desnecessário.

## Segurança

O schema `ops_panel` não é liberado para `anon` ou `authenticated`.

A Edge Function `ops-panel-api` exige chave de backend confiável. A intenção é que o STEP One valide a sessão/permissão do usuário e faça o proxy para essa API. Nunca deve ser colocada service role, chave de backend ou token Smartsheet no frontend/GitHub Pages.

No GitHub Pages, `VITE_OPS_PANEL_PROXY_URL` fica vazio e a aplicação permanece em modo de demonstração. Dentro do STEP One, essa variável aponta para o endpoint same-origin autenticado.
