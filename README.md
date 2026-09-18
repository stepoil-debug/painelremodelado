# STEP Painel Operacional Remodelado

Painel operacional independente para modelar o fluxo de demandas entre setores antes da integração ao STEP One.

## Site

GitHub Pages: https://stepoil-debug.github.io/painelremodelado/

## O que já funciona

- Minha Caixa por setor
- visão de próximas demandas
- fluxo operacional em colunas
- produção ao vivo das etapas dependentes do apontamento
- central de bloqueios
- notificações por setor
- indicadores de WIP, SLA e idade média
- assumir demanda
- avançar progresso
- colocar em espera e retomar
- bloquear e desbloquear
- adicionar evidências demonstrativas
- concluir etapa e realizar handoff automático
- histórico completo por demanda
- persistência local entre recargas
- restauração da demonstração
- GitHub Pages com deploy automático

## Segurança e isolamento

A publicação pública usa exclusivamente dados fictícios de demonstração.

O Supabase operacional da STEP foi inspecionado apenas em leitura. As tabelas de HH permanecem protegidas por RLS e o GitHub Pages não recebe credencial privilegiada.

A integração real com o Apontamento fica desabilitada por padrão. Quando o módulo for colocado dentro do STEP One, o frontend poderá consumir o backend autenticado da intranet sem expor o banco.

A proposta SQL do futuro schema operacional está em `supabase/proposals/` e não é executada automaticamente.


## Hub operacional de dados

A arquitetura real de dados está documentada em `docs/DATA-HUB.md`. O schema `ops_panel` consolida Tracking, WIP, Job Order, Drawing/FCB, 3D Dimensional, Logística e Production Progress PT, sem escrever nas fontes Smartsheet.

O GitHub Pages continua propositalmente em modo demonstrativo. Dados reais devem ser consumidos somente via proxy autenticado do STEP One.
