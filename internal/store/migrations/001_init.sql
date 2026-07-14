create table if not exists sources (
    id          bigserial primary key,
    title       text not null,
    origin      text not null,
    source_url  text not null default '',
    file_name   text not null,
    parent_id   bigint references sources(id) on delete cascade,
    stem        text not null default '',
    duration    double precision not null default 0,
    sample_rate integer not null default 0,
    channels    integer not null default 0,
    size_bytes  bigint not null default 0,
    created_at  timestamptz not null default now()
);

create index if not exists sources_parent_idx on sources (parent_id);

create table if not exists projects (
    id            bigserial primary key,
    source_id     bigint not null references sources(id) on delete cascade,
    name          text not null,
    bpm           double precision not null default 0,
    grid_offset   double precision not null default 0,
    beats_per_bar integer not null default 4,
    detected_key  text not null default '',
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists projects_source_idx on projects (source_id);

create table if not exists slices (
    id         bigserial primary key,
    project_id bigint not null references projects(id) on delete cascade,
    idx        integer not null,
    name       text not null default '',
    start_sec  double precision not null,
    end_sec    double precision not null,
    color      text not null default '',
    created_at timestamptz not null default now()
);

create index if not exists slices_project_idx on slices (project_id, idx);
