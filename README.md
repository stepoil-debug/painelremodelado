# STEP Painel Operacional Remodelado

Painel operacional orientado por **caixa de demandas por setor**, criado de forma isolada para organizar handoffs entre áreas e consumir os dados do Apontamento HH em modo somente leitura.

## Segurança e isolamento

- o aplicativo `apontamentohh` não é alterado;
- nenhuma tabela `public.hh_*` é modificada por este projeto;
- a integração HH do frontend expõe apenas `SELECT`;
- por padrão o sistema inicia com dados simulados;
- a proposta de schema operacional está em `supabase/proposals`, fora de migrations automáticas;
- nenhuma alteração foi aplicada ao banco existente;
- o trabalho da V1 está na branch `feature/operational-panel-v1`.

## Funcionalidades da V1

- **Minha Caixa** por setor;
- novas, em execução, aguardando, bloqueadas, atrasadas e concluídas;
- **Próximas para meu setor** para antecipar carga;
- visão geral de carga por setor;
- produção ao vivo preparada para leitura do HH;
- central de notificações;
- detalhe da demanda com origem, setor atual e próximo destino;
- simulação de aceite de demanda apenas em memória;
- layout alinhado ao STEP One / Apontamento.

## Executar localmente

```bash
npm install
npm run dev
```

O painel sobe em modo isolado e não precisa de Supabase.

## Habilitar leitura real do Apontamento HH

Copie `.env.example` para `.env.local` e preencha somente as credenciais públicas já autorizadas para leitura:

```env
VITE_USE_LIVE_HH_READONLY=true
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

**Nunca usar `service_role` no frontend.**

O adaptador `src/services/hhReadOnly.ts` não oferece métodos de escrita.

## Banco futuro

A proposta `supabase/proposals/001_ops_isolated.sql` descreve um schema `ops` separado para:

- setores e membros;
- workflows e etapas;
- demandas e histórico;
- links com sessões HH;
- handoffs;
- bloqueios;
- eventos;
- notificações;
- transactional outbox;
- auditoria.

Ela é somente uma proposta versionada. **Não executar em produção sem revisão de permissões, RLS e fluxo operacional.**

Veja `docs/ARCHITECTURE.md` para o desenho completo.
