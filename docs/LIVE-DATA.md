# Dados reais no Painel Operacional

A URL pública do GitHub Pages continua em modo demo por segurança. O repositório é público e não pode receber credenciais de backend.

A versão real usa:

1. frontend Vite;
2. `/api/ops-panel` no backend Netlify;
3. segredo `OPS_PANEL_BACKEND_SECRET` somente no runtime;
4. Supabase Edge Function `ops-panel-api`;
5. função `public.ops_panel_get_demands` para a carteira real do Tracking;
6. `public.ops_panel_get_project` para WIP, Job Order, Drawing/FCB, revisões, Dimensional e Logística.

O frontend detecta `VITE_OPS_PANEL_PROXY_URL`. Quando configurado, ele não usa `seedDemands`: carrega a carteira real em modo somente leitura.

O GitHub Pages não recebe esse valor e permanece explicitamente demonstrativo.
