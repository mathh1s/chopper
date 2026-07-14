-- A project stops being one source with some slices, and becomes a pad bank fed by
-- as many sources as you like. Each source keeps its own tempo and grid, because two
-- unrelated songs will not agree on either, and gets warped to the project tempo when
-- its chops are triggered.

create table if not exists project_sources (
    project_id   bigint not null references projects(id) on delete cascade,
    source_id    bigint not null references sources(id) on delete cascade,
    position     integer not null default 0,
    bpm          double precision not null default 0,
    grid_offset  double precision not null default 0,
    detected_key text not null default '',
    pitch        double precision not null default 0,
    sync         boolean not null default true,
    primary key (project_id, source_id)
);

create index if not exists project_sources_project_idx on project_sources (project_id, position);

-- A slice now belongs to a source, not just to a project.
alter table slices
    add column if not exists source_id bigint references sources(id) on delete cascade;

-- Recorded pad performance. Rewritten wholesale on save, like slices, so events point
-- at the slice index rather than the slice id (ids are not stable across a save).
create table if not exists perf_events (
    id         bigserial primary key,
    project_id bigint not null references projects(id) on delete cascade,
    idx        integer not null,
    slice_idx  integer not null,
    at_sec     double precision not null
);

create index if not exists perf_events_project_idx on perf_events (project_id, idx);

-- Loop length of the pad recording, in bars.
alter table projects
    add column if not exists bars integer not null default 4;

-- Backfill: every existing project becomes a one source project, and its slices get
-- pointed at that source.
insert into project_sources (project_id, source_id, position, bpm, grid_offset, detected_key, pitch)
select id, source_id, 0, bpm, grid_offset, detected_key, pitch
from projects
on conflict (project_id, source_id) do nothing;

update slices s
set source_id = p.source_id
from projects p
where s.project_id = p.id
  and s.source_id is null;
