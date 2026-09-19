# STEP Flow — integração somente leitura

Fonte: projeto Supabase **SUPRIMENTOS** (`wccqlijmozeimseaowct`).

A integração não escreve em nenhuma tabela operacional do STEP Flow.

## Vínculo com projeto

O vínculo principal com o painel é extraído de `centro_custo`, por exemplo:

- `BSP 26-955, ANCHIETA`
- `BEP 25-709, PARGO-1A`

O backend normaliza a chave para `26-955`, `25-709`, etc.

## Dados expostos para o painel

- `suprimentos.compras`
- `suprimentos.diligenciamentos`
- `suprimentos.rm_itens`
- `rentals.rental_materials`
- versões de dados dos módulos

A resposta por BSP contém resumo, processos de compra, diligenciamento, itens de RM, distribuição de status de RM e materiais alugados.

## Segurança

O navegador nunca acessa o projeto SUPRIMENTOS diretamente.

Fluxo:

1. navegador autenticado consulta `ops-panel-api` no projeto INTRANET STEP ONE;
2. `ops-panel-api` usa credencial backend privada para consultar `ops-read-api`;
3. `ops-read-api` valida o cliente e executa somente funções SQL de leitura;
4. nenhum método de insert/update/delete é exposto.

Falha no STEP Flow não derruba o detalhe da BSP: o painel retorna os demais dados e registra `stepflow_error`.
