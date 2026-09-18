import { createClient } from '@supabase/supabase-js';
import type { Demand, SectorKey } from '../types';
import { getNextStage, getStage } from '../workflow';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const liveHHReadOnlyEnabled =
  import.meta.env.VITE_USE_LIVE_HH_READONLY === 'true' && Boolean(supabaseUrl && supabaseAnonKey);

const client = liveHHReadOnlyEnabled
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

const activityStageMap: Record<string, string> = {
  fitup: 'fitup',
  montagem: 'fitup',
  solda: 'welding',
  inspecao: 'quality_visual',
  hydro_test: 'hydro_test',
  pintura: 'painting',
  reparo: 'fitup',
  suporte: 'fitup',
  retrabalho: 'fitup',
};

interface HhSessionRow {
  id: string;
  status: string;
  project_key: string | null;
  client: string | null;
  bsp_number: string;
  iso: string;
  activity_key: string;
  activity_name: string;
  start_at: string;
  end_at: string | null;
  elapsed_minutes: number | null;
  finish_status: string | null;
  created_by_name: string | null;
  finished_by_name: string | null;
}

/**
 * Adaptador estritamente somente leitura.
 * Não existem métodos insert/update/delete/rpc nesta camada.
 * A publicação pública do GitHub Pages mantém esta integração desabilitada.
 */
export async function loadHHSessionsReadOnly(): Promise<Demand[]> {
  if (!client) return [];

  const { data, error } = await client
    .from('hh_sessions')
    .select('id,status,project_key,client,bsp_number,iso,activity_key,activity_name,start_at,end_at,elapsed_minutes,finish_status,created_by_name,finished_by_name')
    .order('start_at', { ascending: false })
    .limit(250);

  if (error) throw new Error('Falha na leitura do HH: ' + error.message);

  return ((data ?? []) as HhSessionRow[]).map((row) => {
    const stageKey = activityStageMap[row.activity_key] ?? 'pcp_planning';
    const stage = getStage(stageKey)!;
    const next = getNextStage(stageKey);
    const isOpen = row.status === 'open';
    const actor = row.finished_by_name ?? row.created_by_name ?? 'Apontamento HH';

    return {
      id: 'hh-' + row.id,
      bsp: row.bsp_number,
      iso: row.iso,
      project: row.project_key ?? undefined,
      client: row.client ?? undefined,
      stageKey,
      stage: row.activity_name || stage.label,
      sector: stage.sector as SectorKey,
      originSector: undefined,
      assignedTo: actor,
      priority: 'normal',
      status: isOpen ? 'in_progress' : 'completed',
      enteredAt: row.start_at,
      startedAt: row.start_at,
      completedAt: row.end_at ?? undefined,
      slaDueAt: new Date(new Date(row.start_at).getTime() + stage.slaMinutes * 60_000).toISOString(),
      progress: isOpen ? 50 : 100,
      hhMinutes: row.elapsed_minutes ?? undefined,
      source: 'hh_readonly',
      activityKey: row.activity_key,
      note: row.finish_status ? 'Encerramento: ' + row.finish_status : next ? 'Próximo setor: ' + next.sector : undefined,
      evidences: [],
      history: [{
        id: 'hh-event-' + row.id,
        type: isOpen ? 'accepted' : 'completed',
        title: isOpen ? 'Sessão HH em execução' : 'Sessão HH concluída',
        description: row.activity_name + ' registrada pelo aplicativo de apontamento.',
        at: row.end_at ?? row.start_at,
        actor,
        sector: stage.sector,
      }],
    } satisfies Demand;
  });
}
