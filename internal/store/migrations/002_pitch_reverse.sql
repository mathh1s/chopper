alter table slices
    add column if not exists reverse boolean not null default false;

alter table projects
    add column if not exists pitch double precision not null default 0;

alter table projects
    add column if not exists pitch_linked boolean not null default false;
