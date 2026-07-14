// Package store owns the postgres connection and every query the app runs.
package store

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed all:migrations
var migrations embed.FS

type Source struct {
	ID         int64     `json:"id"`
	Title      string    `json:"title"`
	Origin     string    `json:"origin"`
	SourceURL  string    `json:"source_url"`
	FileName   string    `json:"-"`
	ParentID   *int64    `json:"parent_id"`
	Stem       string    `json:"stem"`
	Duration   float64   `json:"duration"`
	SampleRate int       `json:"sample_rate"`
	Channels   int       `json:"channels"`
	SizeBytes  int64     `json:"size_bytes"`
	CreatedAt  time.Time `json:"created_at"`
}

type Slice struct {
	ID       int64   `json:"id"`
	Idx      int     `json:"idx"`
	Name     string  `json:"name"`
	StartSec float64 `json:"start_sec"`
	EndSec   float64 `json:"end_sec"`
	Color    string  `json:"color"`
}

type Project struct {
	ID          int64     `json:"id"`
	SourceID    int64     `json:"source_id"`
	Name        string    `json:"name"`
	BPM         float64   `json:"bpm"`
	GridOffset  float64   `json:"grid_offset"`
	BeatsPerBar int       `json:"beats_per_bar"`
	DetectedKey string    `json:"detected_key"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	Slices      []Slice   `json:"slices"`
	Source      *Source   `json:"source,omitempty"`
}

type Store struct{ pool *pgxpool.Pool }

func New(ctx context.Context, url string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Migrate applies every file in migrations exactly once, tracked in schema_migrations.
func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
    )`)
	if err != nil {
		return err
	}

	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		var exists bool
		err := s.pool.QueryRow(ctx, `select exists(select 1 from schema_migrations where name = $1)`, name).Scan(&exists)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `insert into schema_migrations (name) values ($1)`, name); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

const sourceCols = `id, title, origin, source_url, file_name, parent_id, stem,
    duration, sample_rate, channels, size_bytes, created_at`

func scanSource(row pgx.Row) (*Source, error) {
	var s Source
	err := row.Scan(&s.ID, &s.Title, &s.Origin, &s.SourceURL, &s.FileName, &s.ParentID, &s.Stem,
		&s.Duration, &s.SampleRate, &s.Channels, &s.SizeBytes, &s.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *Store) CreateSource(ctx context.Context, in Source) (*Source, error) {
	row := s.pool.QueryRow(ctx, `
        insert into sources (title, origin, source_url, file_name, parent_id, stem,
                             duration, sample_rate, channels, size_bytes)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning `+sourceCols,
		in.Title, in.Origin, in.SourceURL, in.FileName, in.ParentID, in.Stem,
		in.Duration, in.SampleRate, in.Channels, in.SizeBytes)
	return scanSource(row)
}

func (s *Store) GetSource(ctx context.Context, id int64) (*Source, error) {
	return scanSource(s.pool.QueryRow(ctx, `select `+sourceCols+` from sources where id = $1`, id))
}

func (s *Store) ListSources(ctx context.Context) ([]Source, error) {
	rows, err := s.pool.Query(ctx, `select `+sourceCols+` from sources order by created_at desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Source{}
	for rows.Next() {
		src, err := scanSource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *src)
	}
	return out, rows.Err()
}

// DeleteSource removes the row and hands back every file name that is now orphaned,
// including the file names of stems that cascade away with the parent.
func (s *Store) DeleteSource(ctx context.Context, id int64) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
        with doomed as (
            select id, file_name from sources where id = $1 or parent_id = $1
        ), gone as (
            delete from sources where id in (select id from doomed) returning file_name
        )
        select file_name from gone`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	files := []string{}
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

func (s *Store) CreateProject(ctx context.Context, sourceID int64, name string) (*Project, error) {
	var p Project
	err := s.pool.QueryRow(ctx, `
        insert into projects (source_id, name)
        values ($1, $2)
        returning id, source_id, name, bpm, grid_offset, beats_per_bar, detected_key, created_at, updated_at`,
		sourceID, name).Scan(&p.ID, &p.SourceID, &p.Name, &p.BPM, &p.GridOffset,
		&p.BeatsPerBar, &p.DetectedKey, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	p.Slices = []Slice{}
	return &p, nil
}

func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.pool.Query(ctx, `
        select id, source_id, name, bpm, grid_offset, beats_per_bar, detected_key, created_at, updated_at
        from projects order by updated_at desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Project{}
	for rows.Next() {
		var p Project
		err := rows.Scan(&p.ID, &p.SourceID, &p.Name, &p.BPM, &p.GridOffset,
			&p.BeatsPerBar, &p.DetectedKey, &p.CreatedAt, &p.UpdatedAt)
		if err != nil {
			return nil, err
		}
		p.Slices = []Slice{}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id int64) (*Project, error) {
	var p Project
	err := s.pool.QueryRow(ctx, `
        select id, source_id, name, bpm, grid_offset, beats_per_bar, detected_key, created_at, updated_at
        from projects where id = $1`, id).Scan(&p.ID, &p.SourceID, &p.Name, &p.BPM, &p.GridOffset,
		&p.BeatsPerBar, &p.DetectedKey, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
        select id, idx, name, start_sec, end_sec, color
        from slices where project_id = $1 order by idx asc`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	p.Slices = []Slice{}
	for rows.Next() {
		var sl Slice
		if err := rows.Scan(&sl.ID, &sl.Idx, &sl.Name, &sl.StartSec, &sl.EndSec, &sl.Color); err != nil {
			return nil, err
		}
		p.Slices = append(p.Slices, sl)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	src, err := s.GetSource(ctx, p.SourceID)
	if err != nil {
		return nil, err
	}
	p.Source = src
	return &p, nil
}

// SaveProject writes the header fields and replaces the slice list wholesale.
func (s *Store) SaveProject(ctx context.Context, p Project) (*Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
        update projects
        set name = $2, bpm = $3, grid_offset = $4, beats_per_bar = $5,
            detected_key = $6, updated_at = now()
        where id = $1`,
		p.ID, p.Name, p.BPM, p.GridOffset, p.BeatsPerBar, p.DetectedKey)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, pgx.ErrNoRows
	}

	if _, err := tx.Exec(ctx, `delete from slices where project_id = $1`, p.ID); err != nil {
		return nil, err
	}

	for i, sl := range p.Slices {
		_, err := tx.Exec(ctx, `
            insert into slices (project_id, idx, name, start_sec, end_sec, color)
            values ($1, $2, $3, $4, $5, $6)`,
			p.ID, i, sl.Name, sl.StartSec, sl.EndSec, sl.Color)
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.GetProject(ctx, p.ID)
}

func (s *Store) DeleteProject(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `delete from projects where id = $1`, id)
	return err
}
