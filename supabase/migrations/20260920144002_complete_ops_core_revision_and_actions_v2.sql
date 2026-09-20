
create table if not exists ops_core.item_aliases (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references ops_core.items(id) on delete cascade,
  project_id uuid not null references ops_core.projects(id) on delete cascade,
  alias text not null,
  alias_norm text not null,
  alias_type text not null default 'source',
  source_system text,
  source_ref text,
  created_at timestamptz not null default now(),
  unique(project_id, alias_norm)
);
create index if not exists item_aliases_item_idx on ops_core.item_aliases(item_id);
create index if not exists item_aliases_project_idx on ops_core.item_aliases(project_id);

create table if not exists ops_core.field_sources (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  field_name text not null,
  value jsonb,
  source_system text not null,
  source_ref text,
  source_field text,
  document_id uuid references ops_core.documents(id) on delete set null,
  revision_id uuid references ops_core.document_revisions(id) on delete set null,
  confidence numeric,
  is_current boolean not null default true,
  captured_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists field_sources_entity_idx
  on ops_core.field_sources(entity_type,entity_id,field_name,is_current,captured_at desc);
create index if not exists field_sources_document_idx
  on ops_core.field_sources(document_id,revision_id);
create unique index if not exists field_sources_current_unique
  on ops_core.field_sources(entity_type,entity_id,field_name,source_system,coalesce(source_ref,''))
  where is_current;

create table if not exists ops_core.document_revision_reviews (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references ops_core.document_revisions(id) on delete cascade,
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected','auto_accepted')),
  reviewed_by text,
  reviewed_at timestamptz,
  note text,
  diff_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(revision_id)
);

alter table ops_core.item_aliases enable row level security;
alter table ops_core.field_sources enable row level security;
alter table ops_core.document_revision_reviews enable row level security;
revoke all on ops_core.item_aliases,ops_core.field_sources,ops_core.document_revision_reviews from anon,authenticated;
grant all on ops_core.item_aliases,ops_core.field_sources,ops_core.document_revision_reviews to service_role;

create or replace function ops_core.revision_rank(value text)
returns bigint
language plpgsql
immutable
as $$
declare
  v text := upper(btrim(coalesce(value,'')));
  letters text;
  digits text;
  total bigint := 0;
  c text;
  idx int;
begin
  if v='' or v='UNSPECIFIED' then return 0; end if;
  v := regexp_replace(v,'^(REV(?:ISION)?|R)[[:space:]._/-]*','','i');
  if v ~ '^[0-9]+$' then return 1000000 + v::bigint; end if;
  if v ~ '^P[0-9]+$' then return 2000000 + substring(v from 2)::bigint; end if;
  if v ~ '^[A-Z]+[0-9]*$' then
    letters := regexp_replace(v,'[0-9]+$','');
    digits := regexp_replace(v,'^[A-Z]+','');
    for idx in 1..length(letters) loop
      c := substr(letters,idx,1);
      total := total * 26 + (ascii(c)-ascii('A')+1);
    end loop;
    return 3000000 + total * 10000 + coalesce(nullif(digits,'')::bigint,0);
  end if;
  return 1;
end $$;

create unique index if not exists one_current_document_revision_idx
  on ops_core.document_revisions(document_id)
  where is_current;

with raw as (
  select i.id item_id,i.project_id,a.alias,a.alias_type,a.source_system,
         ops_core.normalize_alias(a.alias) alias_norm,
         case a.alias_type
           when 'canonical' then 1
           when 'spool' then 2
           when 'iso' then 3
           when 'drawing' then 4
           when 'tag' then 5
           else 9
         end priority
  from ops_core.items i
  cross join lateral (values
    (i.item_key,'canonical','ops_core'),
    (i.spool_code,'spool','bootstrap'),
    (i.iso_code,'iso','bootstrap'),
    (i.drawing_code,'drawing','bootstrap'),
    (i.tag_number,'tag','bootstrap')
  ) a(alias,alias_type,source_system)
  where a.alias is not null
    and ops_core.normalize_alias(a.alias) is not null
),
dedup as (
  select distinct on (project_id,alias_norm)
    item_id,project_id,alias,alias_norm,alias_type,source_system
  from raw
  order by project_id,alias_norm,priority,item_id
)
insert into ops_core.item_aliases(item_id,project_id,alias,alias_norm,alias_type,source_system)
select item_id,project_id,alias,alias_norm,alias_type,source_system
from dedup
on conflict(project_id,alias_norm) do update
set item_id=excluded.item_id,
    alias=excluded.alias,
    alias_type=excluded.alias_type,
    source_system=excluded.source_system;

create or replace function ops_core.record_field_source(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_value jsonb,
  p_source_system text,
  p_source_ref text default null,
  p_source_field text default null,
  p_document_id uuid default null,
  p_revision_id uuid default null,
  p_confidence numeric default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare v_id uuid;
begin
  update ops_core.field_sources
  set is_current=false
  where entity_type=p_entity_type
    and entity_id=p_entity_id
    and field_name=p_field_name
    and source_system=p_source_system
    and coalesce(source_ref,'')=coalesce(p_source_ref,'')
    and is_current;

  insert into ops_core.field_sources(
    entity_type,entity_id,field_name,value,source_system,source_ref,source_field,
    document_id,revision_id,confidence,is_current,metadata
  ) values(
    p_entity_type,p_entity_id,p_field_name,p_value,p_source_system,p_source_ref,p_source_field,
    p_document_id,p_revision_id,p_confidence,true,coalesce(p_metadata,'{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end $$;

insert into ops_core.field_sources(entity_type,entity_id,field_name,value,source_system,source_ref,source_field,confidence,is_current,metadata)
select 'item',i.id,x.field_name,x.value,'tracking_snapshot',
       coalesce(i.legacy_project_row_id,'')||':'||coalesce(i.legacy_iso_key,i.item_key),
       x.field_name,1,true,jsonb_build_object('bootstrap',true)
from ops_core.items i
cross join lateral (values
  ('material',to_jsonb(i.material)),
  ('size',to_jsonb(i.size)),
  ('schedule',to_jsonb(i.schedule)),
  ('weight_kg',to_jsonb(i.weight_kg)),
  ('painting_m2',to_jsonb(i.painting_m2)),
  ('quantity',to_jsonb(i.quantity)),
  ('joints',to_jsonb(i.joints)),
  ('hdg_kg',to_jsonb(i.hdg_kg))
) x(field_name,value)
where x.value is not null and x.value <> 'null'::jsonb
on conflict do nothing;

do $$
begin
  if to_regprocedure('ops_core.sync_drawing_source_row_unprotected(bigint)') is null
     and to_regprocedure('ops_core.sync_drawing_source_row(bigint)') is not null then
    execute 'alter function ops_core.sync_drawing_source_row(bigint) rename to sync_drawing_source_row_unprotected';
  end if;
end $$;

create or replace function ops_core.sync_drawing_source_row(p_source_row_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,ops_panel,public
as $$
declare
  r ops_panel.source_rows%rowtype;
  p ops_core.projects%rowtype;
  d ops_core.documents%rowtype;
  rev ops_core.document_revisions%rowtype;
  v_project_raw text;
  v_core text;
  v_number text;
  v_title text;
  v_key text;
  v_incoming_revision text;
  v_current_revision text;
  v_incoming_rank bigint;
  v_current_rank bigint;
  v_result jsonb;
begin
  select * into r
  from ops_panel.source_rows
  where source_key='drawing' and source_row_id=p_source_row_id and active=true
  order by source_version desc
  limit 1;
  if not found then return jsonb_build_object('ok',false,'reason','drawing-row-not-found'); end if;

  v_project_raw:=coalesce(
    nullif(r.payload #>> '{derived,project_key}',''),
    nullif(r.payload->'cells'->>'Project Number',''),
    nullif(r.payload->'cells'->>'Task Name (BSP, GASP, ICSP,SP)','')
  );
  v_core:=ops_core.normalize_project_core(v_project_raw);

  select * into p from ops_core.projects
  where region='BR' and project_core=v_core
  limit 1;

  if not found then
    return ops_core.sync_drawing_source_row_unprotected(p_source_row_id);
  end if;

  v_number:=coalesce(
    nullif(r.payload #>> '{derived,drawing_number}',''),
    nullif(r.payload->'cells'->>'Drawing Number (Rev. A)','')
  );
  v_title:=coalesce(
    nullif(r.payload #>> '{derived,document_title}',''),
    nullif(r.payload->'cells'->>'Doc. Ref.Client / Title','')
  );
  v_key:=coalesce(ops_core.normalize_alias(v_number),ops_core.normalize_alias(v_title),r.source_row_id::text);
  v_incoming_revision:=coalesce(nullif(btrim(r.payload #>> '{derived,current_revision}'),''),'UNSPECIFIED');

  select * into d
  from ops_core.documents
  where project_id=p.id and document_key=v_key
  limit 1;

  if d.id is not null and d.current_revision is not null then
    v_current_revision:=d.current_revision;
    v_incoming_rank:=ops_core.revision_rank(v_incoming_revision);
    v_current_rank:=ops_core.revision_rank(v_current_revision);

    if v_incoming_revision is distinct from v_current_revision
       and v_incoming_rank < v_current_rank then
      insert into ops_core.document_revisions(
        document_id,revision,source_version,is_current,status,changed_fields,source_payload,detected_at
      )
      values(
        d.id,v_incoming_revision,r.source_version,false,'lower_revision',
        jsonb_build_object(
          'revision',jsonb_build_object('from',v_current_revision,'received',v_incoming_revision),
          'decision','ignored_downgrade'
        ),
        r.payload,now()
      )
      on conflict(document_id,revision,source_version) do update
      set is_current=false,status='lower_revision',source_payload=excluded.source_payload,detected_at=now()
      returning * into rev;

      insert into ops_core.document_revision_reviews(
        revision_id,review_status,reviewed_by,reviewed_at,note,diff_snapshot
      )
      values(
        rev.id,'auto_accepted','system',now(),
        'Revisão inferior armazenada como histórico e impedida de substituir a revisão vigente.',
        jsonb_build_object('current_revision',v_current_revision,'received_revision',v_incoming_revision)
      )
      on conflict(revision_id) do nothing;

      insert into ops_core.audit_events(
        project_id,document_id,entity_type,entity_id,action,source_system,before_data,after_data,metadata
      )
      values(
        p.id,d.id,'document',d.id::text,'document.lower_revision_ignored','drawing',
        jsonb_build_object('current_revision',v_current_revision),
        jsonb_build_object('received_revision',v_incoming_revision,'source_version',r.source_version),
        jsonb_build_object('source_row_id',p_source_row_id)
      );

      return jsonb_build_object(
        'ok',true,'ignored_downgrade',true,'document_id',d.id,
        'current_revision',v_current_revision,'received_revision',v_incoming_revision
      );
    end if;
  end if;

  v_result:=ops_core.sync_drawing_source_row_unprotected(p_source_row_id);

  select * into d
  from ops_core.documents
  where project_id=p.id and document_key=v_key
  limit 1;

  if d.id is not null then
    select * into rev
    from ops_core.document_revisions
    where document_id=d.id and is_current
    order by detected_at desc
    limit 1;

    if rev.id is not null then
      insert into ops_core.document_revision_reviews(
        revision_id,review_status,reviewed_by,reviewed_at,note,diff_snapshot
      )
      values(
        rev.id,
        case when rev.status='same_revision_changed' then 'pending' else 'auto_accepted' end,
        case when rev.status='same_revision_changed' then null else 'system' end,
        case when rev.status='same_revision_changed' then null else now() end,
        case when rev.status='same_revision_changed'
          then 'Conteúdo alterado mantendo a mesma revisão. Requer conferência.'
          else 'Revisão atualizada automaticamente pela fonte documental.' end,
        coalesce(rev.changed_fields,'{}'::jsonb)
      )
      on conflict(revision_id) do update
      set diff_snapshot=excluded.diff_snapshot,
          review_status=case
            when ops_core.document_revision_reviews.review_status='approved' then 'approved'
            else excluded.review_status end,
          note=excluded.note;

      perform ops_core.record_field_source('document',d.id,'current_revision',to_jsonb(d.current_revision),
        'drawing',p_source_row_id::text,'current_revision',d.id,rev.id,1,'{}'::jsonb);
      perform ops_core.record_field_source('document',d.id,'requires_3d',to_jsonb(d.requires_3d),
        'drawing',p_source_row_id::text,'3D Scan (yes/no)',d.id,rev.id,1,'{}'::jsonb);
      perform ops_core.record_field_source('document',d.id,'requires_assembly_simulation',to_jsonb(d.requires_assembly_simulation),
        'drawing',p_source_row_id::text,'Necessita Simulação de Montagem',d.id,rev.id,1,'{}'::jsonb);
      perform ops_core.record_field_source('document',d.id,'quantity',d.metadata->'quantity',
        'drawing',p_source_row_id::text,'QUANTITY',d.id,rev.id,1,'{}'::jsonb);
    end if;
  end if;

  return v_result;
end $$;

create or replace function ops_core.apply_stage_action(
  p_item_id uuid,
  p_action text,
  p_actor_email text,
  p_actor_name text default null,
  p_actor_sector text default null,
  p_progress numeric default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=ops_core,public
as $$
declare
  i ops_core.items%rowtype;
  p ops_core.projects%rowtype;
  s ops_core.item_stages%rowtype;
  w ops_core.workflow_stages%rowtype;
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_sector text:=ops_core.normalize_sector_key(p_actor_sector);
  v_event uuid;
  v_progress numeric;
  v_before jsonb;
  v_handoff uuid;
begin
  select * into i from ops_core.items where id=p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;

  select * into p from ops_core.projects where id=i.project_id;
  if p.source_mode<>'ops_core' then
    raise exception 'Esta BSP ainda está no Tracking legado. Valide o cadastro antes de executar ações operacionais.';
  end if;

  select * into s
  from ops_core.item_stages
  where item_id=i.id and stage_key=i.current_stage_key
  limit 1
  for update;

  if not found then
    select * into s
    from ops_core.item_stages
    where item_id=i.id and is_applicable and status<>'completed'
    order by stage_order
    limit 1
    for update;
  end if;
  if not found then raise exception 'Não há etapa operacional pendente para este item.'; end if;

  select * into w from ops_core.workflow_stages where stage_key=s.stage_key;
  if not found then raise exception 'Etapa operacional sem configuração.'; end if;

  if v_sector is not null and v_sector<>w.sector_key
     and lower(coalesce(p_actor_sector,'')) not in ('admin','administrador','all','todos','pcp') then
    raise exception 'A etapa atual pertence ao setor %, não ao setor do usuário.',w.sector_key;
  end if;

  if v_action in ('progress','complete','start')
     and w.execution_mode='apontamento' then
    raise exception 'Esta etapa é controlada pelo Apontamento HH. O avanço deve ser registrado no aplicativo de apontamento.';
  end if;

  v_before:=to_jsonb(s);

  if v_action='accept' then
    update ops_core.item_stages
    set status=case when status='completed' then status else 'accepted' end,
        accepted_at=coalesce(accepted_at,now()),
        updated_by=coalesce(p_actor_name,p_actor_email),
        updated_at=now()
    where id=s.id;

    update ops_core.handoffs
    set status='accepted',
        accepted_at=coalesce(accepted_at,now()),
        accepted_by=coalesce(p_actor_name,p_actor_email)
    where item_id=i.id and to_stage_key=s.stage_key and status='available'
    returning id into v_handoff;

    update ops_core.items
    set current_stage_key=s.stage_key,current_status='accepted',updated_at=now()
    where id=i.id;

  elsif v_action in ('start','progress') then
    v_progress:=greatest(0,least(99,coalesce(p_progress,case when s.progress>0 then s.progress else 25 end)));
    update ops_core.item_stages
    set progress=v_progress,status='in_progress',
        started_at=coalesce(started_at,now()),
        updated_by=coalesce(p_actor_name,p_actor_email),
        updated_at=now(),
        metadata=metadata||jsonb_build_object('last_note',p_note)
    where id=s.id;
    update ops_core.items
    set current_stage_key=s.stage_key,current_status='in_progress',updated_at=now()
    where id=i.id;
    perform ops_core.recompute_item_progress(i.id);

  elsif v_action='wait' then
    update ops_core.item_stages
    set status='waiting',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),
        metadata=metadata||jsonb_build_object('waiting_note',p_note)
    where id=s.id;
    update ops_core.items set current_status='waiting',updated_at=now() where id=i.id;

  elsif v_action='block' then
    update ops_core.item_stages
    set status='blocked',updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),
        metadata=metadata||jsonb_build_object('blocked_note',p_note,'blocked_at',now())
    where id=s.id;
    update ops_core.items set current_status='blocked',updated_at=now() where id=i.id;

  elsif v_action='resume' then
    update ops_core.item_stages
    set status=case when progress>0 then 'in_progress' when accepted_at is not null then 'accepted' else 'available' end,
        updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now()
    where id=s.id;
    update ops_core.items
    set current_status=case when s.progress>0 then 'in_progress' else 'available' end,updated_at=now()
    where id=i.id;

  elsif v_action='complete' then
    update ops_core.item_stages
    set progress=100,status='completed',
        started_at=coalesce(started_at,now()),completed_at=coalesce(completed_at,now()),
        actual_date=coalesce(actual_date,current_date),
        updated_by=coalesce(p_actor_name,p_actor_email),updated_at=now(),
        metadata=metadata||jsonb_build_object('completion_note',p_note)
    where id=s.id;
    update ops_core.items set current_status='completed_stage',updated_at=now() where id=i.id;
    perform ops_core.recompute_item_progress(i.id);

  else
    raise exception 'Ação operacional inválida: %',p_action;
  end if;

  select progress into v_progress from ops_core.item_stages where id=s.id;

  insert into ops_core.stage_events(
    project_id,item_id,item_stage_id,event_type,stage_key,sector_key,
    progress_from,progress_to,actor_email,actor_name,source_system,source_event_id,payload
  )
  values(
    p.id,i.id,s.id,'stage.'||v_action,s.stage_key,w.sector_key,
    s.progress,v_progress,p_actor_email,p_actor_name,'ops_core',
    gen_random_uuid()::text,
    jsonb_build_object('note',p_note,'before',v_before,'action',v_action)
  )
  returning id into v_event;

  if v_action='complete' then
    return ops_core.advance_item_after_stage(i.id,s.stage_key,v_event,coalesce(p_actor_name,p_actor_email))
      || jsonb_build_object('event_id',v_event);
  end if;

  return jsonb_build_object(
    'ok',true,'project_id',p.id,'item_id',i.id,'stage_key',s.stage_key,
    'action',v_action,'progress',v_progress,'event_id',v_event,'handoff_id',v_handoff
  );
end $$;

create or replace function public.ops_core_stage_action(
  p_item_id uuid,
  p_action text,
  p_actor_email text,
  p_actor_name text default null,
  p_actor_sector text default null,
  p_progress numeric default null,
  p_note text default null
)
returns jsonb
language sql
security definer
set search_path=public,ops_core
as $$
  select ops_core.apply_stage_action(
    p_item_id,p_action,p_actor_email,p_actor_name,p_actor_sector,p_progress,p_note
  );
$$;

create or replace function public.ops_core_notifications(
  p_sector text default null,
  p_user text default null,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path=public,ops_core
as $$
select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb)
from (
  select n.*,p.display_code project_display,
         coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) item_display
  from ops_core.notifications n
  left join ops_core.projects p on p.id=n.project_id
  left join ops_core.items i on i.id=n.item_id
  where (p_sector is null or n.sector_key=ops_core.normalize_sector_key(p_sector))
    and (n.recipient_email is null or p_user is null or lower(n.recipient_email)=lower(p_user))
  order by n.created_at desc
  limit greatest(1,least(coalesce(p_limit,200),1000))
) q;
$$;

create or replace function public.ops_core_notification_read(
  p_notification_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path=public,ops_core
as $$
begin
  update ops_core.notifications
  set read_at=coalesce(read_at,now())
  where id=p_notification_id;
  if not found then raise exception 'Notificação não encontrada.'; end if;
  return jsonb_build_object('ok',true,'id',p_notification_id,'read_at',now(),'actor',p_actor);
end $$;

create or replace view ops_core.current_field_provenance as
select fs.*,p.display_code project_display,
       coalesce(i.spool_code,i.iso_code,i.drawing_code,i.item_key) item_display
from ops_core.field_sources fs
left join ops_core.items i on fs.entity_type='item' and i.id=fs.entity_id
left join ops_core.projects p on p.id=coalesce(i.project_id,
  case when fs.entity_type='project' then fs.entity_id else null end)
where fs.is_current;

grant execute on function public.ops_core_stage_action(uuid,text,text,text,text,numeric,text) to service_role;
grant execute on function public.ops_core_notifications(text,text,integer) to service_role;
grant execute on function public.ops_core_notification_read(uuid,text) to service_role;
grant execute on function ops_core.record_field_source(text,uuid,text,jsonb,text,text,text,uuid,uuid,numeric,jsonb) to service_role;
grant execute on function ops_core.apply_stage_action(uuid,text,text,text,text,numeric,text) to service_role;
