# Tracking histórico / arquivos OLD

O Tracking operacional atual remove projetos finalizados e os transfere para planilhas OLD. O painel consulta o Tracking atual para a carteira do dia a dia e usa os OLDs como índice histórico de busca.

Fontes históricas sincronizadas:
- tracking_old_1 — Progres Tracking Sheet - Old
- tracking_old_3 — Progres Tracking Sheet - Old 3
- tracking_old_5 — Progress Tracking Sheet - Piping Fabrication old 5
- tracking_old_6 — Cópia de Progress Tracking Sheet - old 6
- tracking_old_7 — Progress Tracking Sheet - old 7

Backups/testes como Tracking Sheet - OLD 7-2024 e Teste Old Tracking não são fontes operacionais.

A sincronização usa a versão da planilha antes da carga. A view ops_panel.tracking_archive_items deduplica por projeto + item, escolhendo o OLD mais recente. A busca combina Tracking atual + histórico e dá precedência ao Tracking atual quando uma identidade estiver nos dois locais.
