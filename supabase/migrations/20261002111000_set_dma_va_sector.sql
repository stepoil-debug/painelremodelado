update ops_core.workflow_stages
set sector_key = 'caldeiraria',
    photo_policy = 'required_start_finish',
    execution_mode = 'manual',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('panel_label', 'DMA/VA')
where stage_key = 'scan-initial';
