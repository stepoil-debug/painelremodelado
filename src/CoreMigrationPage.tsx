import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Database,
  FileCheck2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  cutoverCoreProject,
  hubConfigured,
  loadCoreMigrationStatus,
  loadCoreValidationReport,
  loadHubProject,
  loadHubSyncStatus,
  loadRegistrationCandidates,
  materializeCoreCandidate,
  refreshCoreRegistration,
  triggerDrawingSync,
  removeCoreItem,
  upsertCoreItem,
  type HubCoreItemInput,
  type HubCoreMigrationStatus,
  type HubCoreValidationReport,
  type HubRegistrationCandidate,
} from './services/opsPanelHub';
import './core-migration.css';

type CoreItem = HubCoreItemInput & {
  id: string;
  item_key: string;
  current_status?: string | null;
  removed_from_scope?: boolean | null;
  source_metadata?: Record<string, unknown> | null;
};

const emptyItem: HubCoreItemInput = {
  item_type: 'SPOOL',
  iso_code: '',
  spool_code: '',
  drawing_code: '',
  description: '',
  line_number: '',
  material: '',
  size: '',
  schedule: '',
  weight_kg: null,
  painting_m2: null,
  quantity: 1,
  joints: null,
  requires_3d: null,
  requires_assembly_simulation: null,
};

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

function boolLabel(value: unknown) {
  if (value === true) return 'Sim';
  if (value === false) return 'Não';
  return 'A definir';
}

function modeLabel(mode?: string | null) {
  if (mode === 'ops_core') return 'OPS CORE';
  if (mode === 'pending_validation') return 'Pendente validação';
  if (mode === 'legacy_tracking') return 'Tracking legado';
  return 'Nova demanda';
}

function isNewDrawingCandidate(candidate: HubRegistrationCandidate) {
  const detection = candidate.suggested_data?.detection;
  return Boolean(
    candidate.source_systems?.includes('drawing')
    && detection
    && typeof detection === 'object'
    && (detection as Record<string, unknown>).new_project === true
  );
}

export default function CoreMigrationPage() {
  const [status, setStatus] = useState<HubCoreMigrationStatus | null>(null);
  const [candidates, setCandidates] = useState<HubRegistrationCandidate[]>([]);
  const [selected, setSelected] = useState<HubRegistrationCandidate | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadHubProject>> | null>(null);
  const [report, setReport] = useState<HubCoreValidationReport | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<HubCoreItemInput | null>(null);

  async function loadAll() {
    if (!hubConfigured) return;
    setBusy('load');
    setError('');
    try {
      const [migration, queue] = await Promise.all([
        loadCoreMigrationStatus(),
        loadRegistrationCandidates('validation_required', 500),
      ]);
      setStatus(migration);
      setCandidates(queue);
      if (selected) {
        const fresh = queue.find((item) => item.project_core === selected.project_core);
        if (fresh) setSelected(fresh);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Falha ao carregar a fila de validação.');
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function openCandidate(candidate: HubRegistrationCandidate) {
    setSelected(candidate);
    setEditing(null);
    setBusy('detail');
    setError('');
    try {
      if (!candidate.source_mode) {
        setDetail(null);
        setReport(null);
        return;
      }
      const [project, validation] = await Promise.all([
        loadHubProject(candidate.project_core),
        loadCoreValidationReport(candidate.project_core),
      ]);
      setDetail(project);
      setReport(validation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível abrir o cadastro.');
    } finally {
      setBusy('');
    }
  }

  async function prepareCandidate() {
    if (!selected) return;
    setBusy('prepare');
    setError('');
    try {
      await materializeCoreCandidate(selected.project_core);
      setNotice('Cadastro preparado no banco operacional. Revise os itens antes de validar.');
      await loadAll();
      const refreshed = (await loadRegistrationCandidates('', 500))
        .find((item) => item.project_core === selected.project_core);
      if (refreshed) await openCandidate(refreshed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível preparar o cadastro.');
    } finally {
      setBusy('');
    }
  }

  async function refreshSelected() {
    if (!selected) return;
    const [project, validation] = await Promise.all([
      loadHubProject(selected.project_core),
      loadCoreValidationReport(selected.project_core),
    ]);
    setDetail(project);
    setReport(validation);
  }

  async function saveItem(item: HubCoreItemInput) {
    if (!selected) return;
    setBusy('item');
    setError('');
    try {
      await upsertCoreItem(selected.project_core, item);
      setEditing(null);
      setNotice('Item salvo e workflow recalculado.');
      await refreshSelected();
      await loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível salvar o item.');
    } finally {
      setBusy('');
    }
  }

  async function removeItem(item: CoreItem) {
    if (!selected) return;
    const reason = window.prompt('Motivo para retirar este item do escopo:')?.trim();
    if (reason === undefined) return;
    if (!window.confirm('Retirar este item do escopo? O histórico será preservado.')) return;
    setBusy('item');
    setError('');
    try {
      await removeCoreItem(selected.project_core, item.id, reason);
      setNotice('Item retirado do escopo sem apagar o histórico.');
      await refreshSelected();
      await loadAll();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Não foi possível retirar o item.');
    } finally {
      setBusy('');
    }
  }

  async function validateAndCutover() {
    if (!selected || !report?.ready_for_cutover) return;
    const message = selected.source_mode === 'legacy_tracking'
      ? 'Validar esta BSP e retirar o Tracking da operação deste projeto? Depois disso, o painel usará somente o OPS CORE.'
      : 'Validar esta BSP e colocá-la em operação no OPS CORE?';
    if (!window.confirm(message)) return;

    setBusy('cutover');
    setError('');
    try {
      await cutoverCoreProject(selected.project_core);
      setNotice('BSP validada. O OPS CORE agora é a fonte operacional deste projeto.');
      setSelected(null);
      setDetail(null);
      setReport(null);
      await loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível validar a BSP.');
    } finally {
      setBusy('');
    }
  }

  async function refreshQueue() {
    setBusy('refresh');
    setError('');
    try {
      await refreshCoreRegistration();
      setNotice('Fontes conferidas e fila de cadastro atualizada.');
      await loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível atualizar a fila.');
    } finally {
      setBusy('');
    }
  }

  async function refreshDrawing() {
    setBusy('drawing');
    setError('');
    setNotice('Atualização manual do Drawing solicitada. Conferindo novas BSPs...');
    try {
      const request = await triggerDrawingSync();
      let completed = false;

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const sync = await loadHubSyncStatus();
        const drawing = sync.sources.find((source) => source.source_key === 'drawing');

        if (drawing?.last_status === 'error') {
          throw new Error('O Drawing retornou erro na última sincronização.');
        }

        const syncedAtChanged = Boolean(
          drawing?.last_synced_at
          && drawing.last_synced_at !== request.previous_synced_at
        );
        const versionChanged = request.previous_version != null
          && drawing?.last_synced_version != null
          && Number(drawing.last_synced_version) !== Number(request.previous_version);

        if (syncedAtChanged || versionChanged) {
          completed = true;
          break;
        }
      }

      await refreshCoreRegistration();
      const [migration, queue] = await Promise.all([
        loadCoreMigrationStatus(),
        loadRegistrationCandidates('validation_required', 500),
      ]);
      setStatus(migration);
      setCandidates(queue);

      const newDrawing = queue.filter(isNewDrawingCandidate);
      setNotice(
        completed
          ? 'Drawing atualizado. ' + newDrawing.length + ' nova(s) BSP(s) do Drawing aguardando validação.'
          : 'Atualização do Drawing continua em processamento. A fila será atualizada automaticamente ao concluir.'
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível atualizar o Drawing.');
    } finally {
      setBusy('');
    }
  }

  const newDrawingCount = useMemo(
    () => candidates.filter(isNewDrawingCandidate).length,
    [candidates],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((item) =>
      [item.project_core, item.display_code, item.client, item.vessel, item.pm, ...(item.source_systems || [])]
        .some((value) => String(value || '').toLowerCase().includes(q))
    );
  }, [candidates, search]);

  const core = detail?.core as any;
  const items = (Array.isArray(core?.items) ? core.items : [])
    .filter((item: CoreItem) => !item.removed_from_scope) as CoreItem[];

  if (!hubConfigured) {
    return <section className="core-page"><div className="core-empty"><Database /><h2>Cadastro operacional indisponível no modo demo</h2></div></section>;
  }

  return (
    <section className="core-page">
      <div className="core-page-head">
        <div>
          <span className="core-eyebrow">FONTE DA VERDADE · OPS CORE</span>
          <h1>Cadastro e validação operacional</h1>
          <p>Uma BSP validada deixa de usar o Tracking. Novos projetos podem nascer diretamente das fontes técnicas.</p>
        </div>
        <div className="core-page-head-actions">
          <button className="core-button primary" onClick={() => void refreshDrawing()} disabled={Boolean(busy)}>
            <RefreshCw size={16} className={busy === 'drawing' ? 'spin' : ''} /> Atualizar Drawing
          </button>
          <button className="core-button secondary" onClick={() => void refreshQueue()} disabled={Boolean(busy)}>
            <RefreshCw size={16} className={busy === 'refresh' ? 'spin' : ''} /> Atualizar cadastro
          </button>
        </div>
      </div>

      {notice && <div className="core-message success"><CheckCircle2 size={17} />{notice}<button onClick={() => setNotice('')}><X size={15} /></button></div>}
      {error && <div className="core-message error"><AlertTriangle size={17} />{error}<button onClick={() => setError('')}><X size={15} /></button></div>}

      <div className="core-kpis">
        <article><span>BSPs atuais</span><strong>{status?.projects.total ?? '—'}</strong><small>snapshot inicial preservado</small></article>
        <article><span>No OPS CORE</span><strong>{status?.projects.cutover ?? '—'}</strong><small>sem leitura do Tracking</small></article>
        <article><span>Legado</span><strong>{status?.projects.legacy ?? '—'}</strong><small>aguardando validação</small></article>
        <article><span>Fila de validação</span><strong>{status?.candidates.pending ?? '—'}</strong><small>fontes operacionais</small></article>
        <article className={newDrawingCount > 0 ? 'core-kpi-alert' : ''}><span>Novas do Drawing</span><strong>{newDrawingCount}</strong><small>{newDrawingCount > 0 ? 'requer conferência' : 'nenhuma nova BSP'}</small></article>
        <article><span>Itens migrados</span><strong>{status?.items.total ?? '—'}</strong><small>com histórico de etapas</small></article>
      </div>

      <div className="core-layout">
        <aside className="core-queue">
          <div className="core-queue-head">
            <div><strong>Fila de cadastro</strong><small>{filtered.length} registro(s)</small></div>
            {busy === 'load' && <LoaderCircle className="spin" size={18} />}
          </div>
          <label className="core-search">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar BSP, cliente, vessel ou PM..." />
          </label>
          <div className="core-queue-list">
            {filtered.map((item) => (
              <button
                key={item.id}
                className={'core-candidate ' + (selected?.id === item.id ? 'active' : '')}
                onClick={() => void openCandidate(item)}
              >
                <div>
                  <strong>{item.display_code || item.project_core}</strong>
                  <span>{item.client || 'Cliente a confirmar'} · {item.vessel || 'Vessel a confirmar'}</span>
                  <small>{(item.source_systems || []).join(' + ') || 'fonte pendente'}</small>
                </div>
                <div className="core-candidate-meta">
                  {isNewDrawingCandidate(item) && <em className="mode drawing-new">NOVA DO DRAWING</em>}
                  <em className={'mode ' + (item.source_mode || 'new')}>{modeLabel(item.source_mode)}</em>
                  <span>{item.item_count ?? 0} itens</span>
                  <ChevronRight size={16} />
                </div>
              </button>
            ))}
            {!filtered.length && !busy && <div className="core-empty compact"><ShieldCheck size={22} /><p>Nenhuma BSP pendente neste filtro.</p></div>}
          </div>
        </aside>

        <main className="core-detail">
          {!selected ? (
            <div className="core-empty">
              <FileCheck2 size={36} />
              <h2>Selecione uma BSP</h2>
              <p>Confira as fontes, itens, documentos e divergências antes do corte.</p>
            </div>
          ) : !selected.source_mode ? (
            <div className="core-prepare">
              <span className="core-eyebrow">NOVA DEMANDA DETECTADA</span>
              <h2>{selected.display_code}</h2>
              <p>Esta demanda existe nas fontes operacionais, mas ainda não possui cadastro no OPS CORE.</p>
              <div className="core-source-list">{selected.source_systems.map((source) => <span key={source}>{source}</span>)}</div>
              <button className="core-button primary" onClick={() => void prepareCandidate()} disabled={busy === 'prepare'}>
                {busy === 'prepare' ? <LoaderCircle className="spin" size={16} /> : <Database size={16} />}
                Preparar cadastro
              </button>
              <small>Nenhuma linha será criada no Tracking.</small>
            </div>
          ) : busy === 'detail' && !detail ? (
            <div className="core-empty"><LoaderCircle className="spin" size={28} /><p>Carregando cadastro...</p></div>
          ) : (
            <>
              <div className="core-detail-head">
                <div>
                  <span className="core-eyebrow">{modeLabel(selected.source_mode)}</span>
                  <h2>{selected.display_code}</h2>
                  <p>{selected.client || core?.project?.client || 'Cliente a confirmar'} · {selected.vessel || core?.project?.vessel || 'Vessel a confirmar'}</p>
                </div>
                <button className="core-button secondary" onClick={() => setEditing({ ...emptyItem })}><Plus size={16} />Adicionar item</button>
              </div>

              <div className="core-validation">
                <div className={'core-ready ' + (report?.ready_for_cutover ? 'ready' : 'pending')}>
                  {report?.ready_for_cutover ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
                  <div>
                    <strong>{report?.ready_for_cutover ? 'Cadastro apto para validação' : 'Cadastro ainda possui bloqueios'}</strong>
                    <small>{report?.ready_for_cutover ? 'O corte pode ser executado com rastreabilidade.' : 'Corrija os pontos abaixo antes de validar.'}</small>
                  </div>
                </div>
                {report?.blocking_issues?.map((issue) => <p className="core-blocking" key={issue}>{issue}</p>)}
                <div className="core-warnings">
                  <span>Peso ausente: <b>{report?.warnings?.missing_weight ?? 0}</b></span>
                  <span>Material ausente: <b>{report?.warnings?.missing_material ?? 0}</b></span>
                  <span>Não classificados: <b>{report?.warnings?.unclassified_items ?? 0}</b></span>
                  <span>Detalhamento pendente: <b>{report?.warnings?.provisional_breakdown ?? 0}</b></span>
                </div>
              </div>

              <div className="core-items-title">
                <div><strong>Itens operacionais</strong><small>{items.length} item(ns) ativos</small></div>
              </div>
              <div className="core-table-wrap">
                <table className="core-table">
                  <thead><tr><th>Item</th><th>Tipo</th><th>Material</th><th>Dimensão</th><th>Peso</th><th>Qtd.</th><th>3D</th><th>Simulação</th><th /></tr></thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td><strong>{item.spool_code || item.iso_code || item.drawing_code || item.item_key}</strong><small>{item.drawing_code || ''}</small></td>
                        <td>{item.item_type || 'OTHER'}</td>
                        <td>{item.material || '—'}</td>
                        <td>{[item.size, item.schedule].filter(Boolean).join(' · ') || '—'}</td>
                        <td>{item.weight_kg ?? '—'}</td>
                        <td>{item.quantity ?? '—'}</td>
                        <td>{boolLabel(item.requires_3d)}</td>
                        <td>{boolLabel(item.requires_assembly_simulation)}</td>
                        <td className="core-row-actions">
                          <button title="Editar" onClick={() => setEditing({ ...item })}><Save size={15} /></button>
                          <button title="Retirar do escopo" onClick={() => void removeItem(item)}><Trash2 size={15} /></button>
                        </td>
                      </tr>
                    ))}
                    {!items.length && <tr><td colSpan={9} className="core-no-items">Nenhum item cadastrado. Adicione os itens antes de validar.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="core-cutover">
                <div>
                  <strong>{selected.source_mode === 'legacy_tracking' ? 'Corte Tracking → OPS CORE' : 'Ativar projeto no OPS CORE'}</strong>
                  <p>{selected.source_mode === 'legacy_tracking'
                    ? 'Ao validar, esta BSP deixa imediatamente de ler o Tracking no painel operacional.'
                    : 'A BSP passa a fazer parte da operação sem nunca ser cadastrada no Tracking.'}</p>
                </div>
                <button className="core-button primary" disabled={!report?.ready_for_cutover || busy === 'cutover'} onClick={() => void validateAndCutover()}>
                  {busy === 'cutover' ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Validar e ativar
                </button>
              </div>
            </>
          )}
        </main>
      </div>

      {editing && selected && (
        <ItemEditor
          item={editing}
          saving={busy === 'item'}
          onClose={() => setEditing(null)}
          onSave={(item) => void saveItem(item)}
        />
      )}
    </section>
  );
}

function ItemEditor(props: {
  item: HubCoreItemInput;
  saving: boolean;
  onClose: () => void;
  onSave: (item: HubCoreItemInput) => void;
}) {
  const [form, setForm] = useState<HubCoreItemInput>(props.item);
  const set = (key: keyof HubCoreItemInput, value: unknown) => setForm((current) => ({ ...current, [key]: value }));

  const numberOrNull = (value: string) => {
    if (!value.trim()) return null;
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  };

  return (
    <div className="core-modal-backdrop">
      <form className="core-modal" onSubmit={(event) => { event.preventDefault(); props.onSave(form); }}>
        <div className="core-modal-head"><div><span className="core-eyebrow">ITEM OPERACIONAL</span><h3>{form.id ? 'Editar item' : 'Adicionar item'}</h3></div><button type="button" onClick={props.onClose}><X /></button></div>
        <div className="core-form-grid">
          <label>Tipo<select value={form.item_type || 'SPOOL'} onChange={(e) => set('item_type', e.target.value)}><option>SPOOL</option><option>SUPPORT</option><option>STRUCTURE</option><option>FRAME</option><option>OTHER</option></select></label>
          <label>ISO<input value={form.iso_code || ''} onChange={(e) => set('iso_code', e.target.value)} placeholder="ISO-001" /></label>
          <label>Spool / item<input value={form.spool_code || ''} onChange={(e) => set('spool_code', e.target.value)} placeholder="SPL-01" /></label>
          <label>Drawing<input value={form.drawing_code || ''} onChange={(e) => set('drawing_code', e.target.value)} placeholder="BSP-26-000-ISO-001" /></label>
          <label>Line Nº<input value={form.line_number || ''} onChange={(e) => set('line_number', e.target.value)} /></label>
          <label>Material<input value={form.material || ''} onChange={(e) => set('material', e.target.value)} /></label>
          <label>Size<input value={form.size || ''} onChange={(e) => set('size', e.target.value)} /></label>
          <label>SCH<input value={form.schedule || ''} onChange={(e) => set('schedule', e.target.value)} /></label>
          <label>Peso kg<input inputMode="decimal" value={numberValue(form.weight_kg)} onChange={(e) => set('weight_kg', numberOrNull(e.target.value))} /></label>
          <label>M² pintura<input inputMode="decimal" value={numberValue(form.painting_m2)} onChange={(e) => set('painting_m2', numberOrNull(e.target.value))} /></label>
          <label>Quantidade<input inputMode="decimal" value={numberValue(form.quantity)} onChange={(e) => set('quantity', numberOrNull(e.target.value))} /></label>
          <label>Juntas<input inputMode="decimal" value={numberValue(form.joints)} onChange={(e) => set('joints', numberOrNull(e.target.value))} /></label>
          <label>3D<select value={form.requires_3d === true ? 'yes' : form.requires_3d === false ? 'no' : ''} onChange={(e) => set('requires_3d', e.target.value === '' ? null : e.target.value === 'yes')}><option value="">A definir</option><option value="yes">Sim</option><option value="no">Não</option></select></label>
          <label>Simulação<select value={form.requires_assembly_simulation === true ? 'yes' : form.requires_assembly_simulation === false ? 'no' : ''} onChange={(e) => set('requires_assembly_simulation', e.target.value === '' ? null : e.target.value === 'yes')}><option value="">A definir</option><option value="yes">Sim</option><option value="no">Não</option></select></label>
          <label className="wide">Descrição<textarea value={form.description || ''} onChange={(e) => set('description', e.target.value)} rows={3} /></label>
        </div>
        <div className="core-modal-actions"><button type="button" className="core-button secondary" onClick={props.onClose}>Cancelar</button><button type="submit" className="core-button primary" disabled={props.saving}><Save size={16} />Salvar item</button></div>
      </form>
    </div>
  );
}
