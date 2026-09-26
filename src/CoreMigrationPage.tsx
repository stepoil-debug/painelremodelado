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
  hubConfigured,
  loadCoreMigrationStatus,
  loadCoreValidationReport,
  loadCoreRegistrationDetail,
  loadHubSyncStatus,
  loadRegistrationCandidates,
  autoRegisterCoreCandidate,
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
  return 'Pendente';
}

function isNewDrawingCandidate(candidate: HubRegistrationCandidate) {
  const detection = candidate.suggested_data?.detection;
  return Boolean(
    (candidate.source_systems?.includes('fcb') || candidate.fcb_status === 'detected')
    && detection
    && typeof detection === 'object'
    && (detection as Record<string, unknown>).source === 'fcb'
    && (detection as Record<string, unknown>).new_project === true
  );
}

function candidateFcbStatus(candidate: HubRegistrationCandidate) {
  return candidate.fcb_status
    || (candidate.suggested_data?.fcb as Record<string, unknown> | undefined)?.status
    || 'awaiting_fcb';
}

function trackingValidationLabel(status?: string | null) {
  if (status === 'matched') return 'Tracking conferido';
  if (status === 'mismatch') return 'Divergência no Tracking';
  if (status === 'not_found') return 'Tracking não encontrado';
  return 'Tracking ainda não conferido';
}

export default function CoreMigrationPage() {
  const [status, setStatus] = useState<HubCoreMigrationStatus | null>(null);
  const [candidates, setCandidates] = useState<HubRegistrationCandidate[]>([]);
  const [selected, setSelected] = useState<HubRegistrationCandidate | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadCoreRegistrationDetail>> | null>(null);
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
        // The backend automatically registers complete FCB candidates. Keep
        // only candidates that still have missing information in this queue.
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
        loadCoreRegistrationDetail(candidate.project_core),
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

  async function registerCandidate() {
    if (!selected) return;
    setBusy('register');
    setError('');
    try {
      const result = await autoRegisterCoreCandidate(selected.project_core);
      setNotice(
        result.awaiting_fcb
          ? selected.display_code + ' ficou pendente em modo observação: aguardando o FCB técnico vigente.'
          : selected.display_code + ' foi atualizada no banco de validação. Nenhum painel operacional foi alterado.'
      );
      setSelected(null);
      setDetail(null);
      setReport(null);
      await loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível cadastrar a BSP.');
    } finally {
      setBusy('');
    }
  }

  async function refreshSelected() {
    if (!selected) return;
    const [project, validation] = await Promise.all([
      loadCoreRegistrationDetail(selected.project_core),
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
        loadRegistrationCandidates('', 500),
      ]);
      setStatus(migration);
      setCandidates(queue);

      const newDrawing = queue.filter(isNewDrawingCandidate);
      setNotice(
        completed
          ? 'FCB atualizado. ' + newDrawing.length + ' nova(s) BSP(s) do FCB aguardando validação.'
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

  const core = detail as any;
  const nonBlockingWarnings = report?.non_blocking_warnings || [];
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
          <p>FCB é a autoridade técnica; WIP/Job Order complementam o cadastro e o Tracking é usado somente para validação nesta fase. O modo observação preserva os painéis operacionais.</p>
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
        <article className={newDrawingCount > 0 ? 'core-kpi-alert' : ''}><span>Novas do FCB</span><strong>{newDrawingCount}</strong><small>{newDrawingCount > 0 ? 'requer conferência' : 'nenhuma nova BSP'}</small></article>
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
                  <small>{(item.source_systems || []).join(' + ') || 'fonte pendente'} · FCB {candidateFcbStatus(item) === 'detected' ? 'detectado' : 'aguardando'}</small>
                </div>
                <div className="core-candidate-meta">
                  {isNewDrawingCandidate(item) && <em className="mode drawing-new">NOVA DO FCB</em>}
                  <em className={'mode ' + (item.source_mode || 'pending')}>{modeLabel(item.source_mode)}</em>
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
              <p>Selecione uma BSP pendente para cadastrá-la automaticamente.</p>
            </div>
          ) : !selected.source_mode ? (
            <div className="core-prepare core-pending-register">
              <span className="core-eyebrow">PENDENTE DE CADASTRO</span>
              <h2>{selected.display_code}</h2>
              <p>{candidateFcbStatus(selected) === 'detected'
                ? 'O FCB foi detectado. O cadastro será montado com os dados técnicos do FCB e os dados cadastrais do WIP/Job Order.'
                : 'A BSP foi encontrada nas fontes auxiliares, mas ainda não possui FCB vigente. Ela permanece somente como pré-cadastro.'}</p>
              <div className="core-source-list">{selected.source_systems.map((source) => <span key={source}>{source}</span>)}</div>
              <button className="core-button primary core-register-button" onClick={() => void registerCandidate()} disabled={busy === 'register' || candidateFcbStatus(selected) !== 'detected'}>
                {busy === 'register' ? <LoaderCircle className="spin" size={16} /> : <Database size={16} />}
                {busy === 'register' ? 'Cadastrando...' : candidateFcbStatus(selected) === 'detected' ? 'Cadastrar pelo FCB' : 'Aguardando FCB'}
              </button>
              <small>FCB = autoridade técnica. WIP/Job Order complementam o cadastro. Tracking será consultado somente para validação e nunca será alterado.</small>
            </div>
          ) : busy === 'detail' && !detail ? (
            <div className="core-empty"><LoaderCircle className="spin" size={28} /><p>Carregando cadastro...</p></div>
          ) : (
            <>
              <div className="core-detail-head">
                <div>
                  <span className="core-eyebrow">{report?.fcb?.status === 'awaiting_fcb' ? 'AGUARDANDO FCB' : modeLabel(selected.source_mode)}</span>
                  <h2>{selected.display_code}</h2>
                  <p>{selected.client || core?.project?.client || 'Cliente a confirmar'} · {selected.vessel || core?.project?.vessel || 'Vessel a confirmar'} · Autoridade: FCB</p>
                </div>
                {report?.fcb?.status !== 'awaiting_fcb' && (
                  <button className="core-button secondary" onClick={() => setEditing({ ...emptyItem })}><Plus size={16} />Adicionar item</button>
                )}
              </div>

              <div className="core-validation">
                <div className={'core-ready ' + (report?.ready_for_cutover ? 'ready' : 'pending')}>
                  {report?.ready_for_cutover ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
                  <div>
                    <strong>
                      {report?.ready_for_cutover
                        ? nonBlockingWarnings.length
                          ? 'Cadastro técnico liberado com pendências informativas'
                          : 'Cadastro técnico completo'
                        : report?.fcb?.status === 'awaiting_fcb'
                          ? 'Aguardando FCB técnico'
                          : 'Cadastro técnico em validação'}
                    </strong>
                    <small>
                      {report?.ready_for_cutover
                        ? nonBlockingWarnings.length
                          ? 'A BSP pode ser cadastrada. Complete os campos pendentes diretamente nesta tela quando a informação estiver disponível.'
                          : 'Os dados técnicos foram validados e o projeto pode ser ativado.'
                        : report?.fcb?.status === 'awaiting_fcb'
                          ? 'O Drawing gerou somente um pré-cadastro. Peso, material, dimensão e demais dados serão carregados do FCB vigente.'
                          : 'O FCB foi detectado, mas o cadastro técnico ainda precisa concluir a importação/validação.'}
                    </small>
                  </div>
                </div>
                {report?.blocking_issues?.map((issue) => <p className="core-blocking" key={issue}>{issue}</p>)}
                {nonBlockingWarnings.map((warning) => <p className="core-non-blocking" key={warning}><AlertTriangle size={15} />{warning}</p>)}
                <div className="core-warnings">
                  <span>FCB detectado: <b>{report ? (report.fcb?.has_fcb ? 'Sim' : 'Não') : '—'}</b></span>
                  <span>Revisão FCB: <b>{report?.fcb?.latest_revision || '—'}</b></span>
                  <span>Tracking: <b>{trackingValidationLabel(report?.tracking_validation?.status)}</b></span>
                  <span>Itens FCB / Tracking: <b>{report?.tracking_validation ? `${report.fcb?.has_fcb ? report.items?.item_count ?? 0 : report.tracking_validation.fcb_item_count ?? 0} / ${report.tracking_validation.tracking_item_count ?? report.tracking_validation.source_count ?? 0}` : '—'}</b></span>
                  <span>Itens provisórios: <b>{report ? report.warnings?.provisional_drawing_items ?? 0 : '—'}</b></span>
                  <span>Itens técnicos: <b>{report?.fcb?.has_fcb ? report.items?.item_count ?? '—' : 'aguardando FCB'}</b></span>
                </div>
                {report?.tracking_validation?.status === 'mismatch' && <p className="core-blocking tracking-warning">Divergência encontrada no Tracking apenas para conferência. O FCB continua sendo a fonte técnica e o Tracking não será alterado.</p>}
              </div>

              <div className="core-items-title">
                <div>
                  <strong>{report?.fcb?.status === 'awaiting_fcb' ? 'Pré-cadastro do Drawing' : 'Itens operacionais'}</strong>
                  <small>
                    {report?.fcb?.status === 'awaiting_fcb'
                      ? items.length + ' registro(s) provisório(s) - não são dados técnicos finais'
                      : items.length + ' item(ns) ativos'}
                  </small>
                </div>
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
                          {report?.fcb?.status !== 'awaiting_fcb' && (
                            <>
                              <button title="Editar" onClick={() => setEditing({ ...item })}><Save size={15} /></button>
                              <button title="Retirar do escopo" onClick={() => void removeItem(item)}><Trash2 size={15} /></button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!items.length && <tr><td colSpan={9} className="core-no-items">Nenhum item cadastrado. Adicione os itens antes de validar.</td></tr>}
                  </tbody>
                </table>
              </div>

              <div className="core-cutover">
                <div>
                  <strong>Modo observação ativo</strong>
                  <p>
                    {report?.fcb?.status === 'awaiting_fcb'
                      ? 'A BSP continuará aguardando o FCB técnico. Nenhum dado deste cadastro será enviado aos painéis operacionais.'
                      : report?.ready_for_cutover
                        ? 'O cadastro está tecnicamente pronto para uma futura ativação, mas a ativação está bloqueada nesta fase. O Tracking continua sendo a fonte dos painéis.'
                        : 'O cadastro permanece isolado para conferência. Nenhuma alteração será aplicada aos painéis operacionais.'}
                  </p>
                </div>
                <span className="core-observation-badge"><ShieldCheck size={16} /> Painéis preservados</span>
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
