-- Existing handoffs created before the 25% rule must follow the same contract.
update ops_core.panel_legacy_stage_advances
set panel_status='in_progress',
    panel_progress=25,
    last_note=coalesce(last_note,'') || case when coalesce(last_note,'')='' then '' else ' · ' end || 'Etapa iniciada automaticamente em 25% após handoff.',
    updated_at=now()
where last_action='handoff'
  and panel_status='new'
  and coalesce(panel_progress,0)=0;
