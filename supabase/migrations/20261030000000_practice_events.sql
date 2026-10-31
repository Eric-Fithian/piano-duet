create table public.practice_events (
  user_id uuid not null references auth.users(id),
  id text not null,
  sequence bigint generated always as identity,
  received_at timestamptz not null default now(),
  event jsonb not null,
  primary key (user_id, id),
  unique (sequence),
  check (event ->> 'id' = id)
);

create index practice_events_pull on public.practice_events (user_id, sequence);
alter table public.practice_events enable row level security;
create policy "Users read their own events" on public.practice_events for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users insert their own events" on public.practice_events for insert to authenticated with check ((select auth.uid()) = user_id);
revoke all on public.practice_events from anon, authenticated;
grant select on public.practice_events to authenticated;

-- Serializing writers until commit prevents a pull cursor from passing an uncommitted sequence.
create function public.push_practice_events(events jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
  account uuid := auth.uid();
  stored jsonb;
begin
  if account is null or jsonb_typeof(events) <> 'array' or jsonb_array_length(events) > 100 then
    raise exception 'Invalid event batch';
  end if;
  perform pg_advisory_xact_lock(1212761957, 1);
  for item in select value from jsonb_array_elements(events) loop
    if jsonb_typeof(item) <> 'object' or coalesce(item ->> 'id', '') = '' then
      raise exception 'Invalid event';
    end if;
    insert into public.practice_events (user_id, id, event) values (account, item ->> 'id', item)
      on conflict (user_id, id) do nothing;
    select event into stored from public.practice_events where user_id = account and id = item ->> 'id';
    if stored <> item then raise exception 'Conflicting event %', item ->> 'id'; end if;
  end loop;
end;
$$;
revoke all on function public.push_practice_events(jsonb) from public, anon;
grant execute on function public.push_practice_events(jsonb) to authenticated;
