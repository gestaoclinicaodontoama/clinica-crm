-- Públicos: segmentos salvos (regra dinâmica) para montar listas de disparo.
create table if not exists public.publicos (
  id bigserial primary key,
  nome text not null,
  regra jsonb not null default '{}'::jsonb,
  criado_por uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- DDD a partir do telefone: tira 55/0 à esquerda. Só LÊ (não altera cadastro).
create or replace function public._ddd_do_telefone(t text)
returns text language sql immutable as $$
  select case
    when t ~ '^55' then substring(t from 3 for 2)
    when t ~ '^0'  then substring(t from 2 for 2)
    else substring(t from 1 for 2)
  end;
$$;

-- Busca leads que casam com a regra. _limit null = sem limite (usado pelo contar).
create or replace function public.publico_buscar(regra jsonb, _limit int default 20, _offset int default 0)
returns table(id bigint, nome text, telefone text, status text, origem text, criado_em timestamptz)
language sql stable as $$
  with p as (
    select
      nullif(regra->'interesse'->>'termo','')                as termo,
      coalesce(regra->'interesse'->'em', '["origem","conversa","anuncio"]'::jsonb) as fontes,
      regra->'status'                                        as status_arr,
      (regra->'periodo'->>'dias')::int                       as dias,
      regra->'ddd'                                           as ddd_arr,
      regra->'origem'                                        as origem_arr,
      (regra->'engajamento'->>'respondeu')::boolean          as resp,
      (regra->'engajamento'->>'ultima_interacao_dias')::int  as ui_dias,
      (regra->'engajamento'->>'janela24h')::boolean          as j24,
      (regra->'engajamento'->>'recebeu_campanha_id')::bigint as camp
  )
  select l.id, l.nome, l.telefone, l.status, l.origem, l.criado_em
  from leads l, p
  where coalesce(l.telefone,'') <> ''
    and (p.termo is null or (
         (p.fontes ? 'origem'   and l.origem ilike '%'||p.termo||'%')
      or (p.fontes ? 'conversa' and exists(select 1 from mensagens m where m.lead_id=l.id and m.texto ilike '%'||p.termo||'%'))
      or (p.fontes ? 'anuncio'  and l.referral_data::text ilike '%'||p.termo||'%')
    ))
    and (p.status_arr is null or jsonb_array_length(p.status_arr)=0 or l.status in (select jsonb_array_elements_text(p.status_arr)))
    and (p.dias is null or l.criado_em >= now() - (p.dias || ' days')::interval)
    and (p.ddd_arr is null or jsonb_array_length(p.ddd_arr)=0 or public._ddd_do_telefone(l.telefone) in (select jsonb_array_elements_text(p.ddd_arr)))
    and (p.origem_arr is null or jsonb_array_length(p.origem_arr)=0 or l.origem in (select jsonb_array_elements_text(p.origem_arr)))
    and (p.resp is null or p.resp = exists(select 1 from mensagens m where m.lead_id=l.id and m.direcao='recebida'))
    and (p.ui_dias is null or exists(select 1 from mensagens m where m.lead_id=l.id and m.criada_em >= now() - (p.ui_dias || ' days')::interval))
    and (p.j24 is null or p.j24 = exists(select 1 from mensagens m where m.lead_id=l.id and m.direcao='recebida' and m.criada_em >= now() - interval '24 hours'))
    and (p.camp is null or exists(select 1 from disparos_contatos dc where dc.lead_id=l.id and dc.campanha_id=p.camp and dc.status='enviado'))
  order by l.criado_em desc
  limit _limit offset _offset;
$$;

-- Conta reusando a mesma lógica (DRY): _limit null = todos.
create or replace function public.publico_contar(regra jsonb)
returns bigint language sql stable as $$
  select count(*)::bigint from public.publico_buscar(regra, null, 0);
$$;
