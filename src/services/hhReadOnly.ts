import { createClient } from '@supabase/supabase-js';
import type { Demand, SectorKey } from '../types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const liveHHReadOnlyEnabled =
  import.meta.env.VITE_USE_LIVE_HH_READONLY === 'true' && Boolean(supabaseUrl && supabaseAnonKey);

const client = liveHHReadOnlyEnabled
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

const activitySectorMap: Record<string, SectorKey> = {
  fitup: 'caldeiraria',
  montagem: 'caldeiraria',
  solda: 'solda',
  inspecao: 'qualidade',
  hydro_test: 'qualidade',
  pintura: 'pintura',
  reparo: 'caldeiraria',
  suporte: 'caldeiraria',
  retrabalho: 'caldeiraria',
};

const nextSectorMap: Partial<Record<SectorKey, SectorKey>> = {
  caldeiraria: 'solda',
  solda: 'qualidade',
  qualidade: 'pintura',
  pintura: 'expedicao',
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
  total_hh: number | null;
  finish_status: string | null;
  created_by_name: string | null;
  finished_by_name: string | null;
}

/**
 * ÚNICO adaptador permitido para o banco do Apontamento HH.
 * Esta camada expõe somente SELECT. Não existem métodos insert/update/delete/rpc.
 * O painel deve continuar funcional sem esta integração, usando dados isolados.
 */
export async function loadHHSessionsReadOnly(): Promise<Demand[]> {
  if (!client) return [];

  const { data, error } = await client
    .from('hh_sessions')
    .select('id,status,project_key,client,bsp_number,iso,activity_key,activity_name,start_at,end_at,elapsed_minutes,total_hh,finish_status,created_by_name,finished_by_name')
    .order('start_at', { ascending: false })
    .limit(250);

  if (error) throw new Error(`Falha na leitura do HH: ${error.message}`);

  return ((data ?? []) as HhSessionRow[]).map((row) => {
    const sector = activitySectorMap[row.activity_key] ?? 'pcp';
    const isOpen = row.status === 'open';

    return {
      id: `hh-${row.id}`,
      bsp: row.bsp_number,
      iso: row.iso,
      project: row.project_key ?? undefined,
      client: row.client ?? undefined,
      stage: row.activity_name,
      sector,
      nextSector: nextSectorMap[sector],
      assignedTo: row.finished_by_name ?? row.created_by_name ?? undefined,
      priority: 'normal',
      status: isOpen ? 'in_progress' : 'completed',
      enteredAt: row.start_at,
      progress: isOpen ? 50 : 100,
      hhMinutes: row.elapsed_minutes ?? undefined,
      photoEvidence: 0,
      source: 'hh_readonly',
      activityKey: row.activity_key,
      note: row.finish_status ? `Encerramento: ${row.finish_status}` : undefined,
    } satisfies Demand;
  });
}
