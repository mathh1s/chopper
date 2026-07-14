// Package media turns anything the user throws at us into one canonical wav on disk.
//
// Everything is normalised to 16 bit pcm wav at the source sample rate, because that
// is the one format every browser can hand to decodeAudioData without arguing, and it
// is also the format you want to drag into FL Studio afterwards.
package media

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/mathiiiiiis/chopper/internal/config"
)

type Info struct {
	Title      string
	FileName   string
	Duration   float64
	SampleRate int
	Channels   int
	SizeBytes  int64
}

type Media struct{ cfg config.Config }

func New(cfg config.Config) *Media { return &Media{cfg: cfg} }

// StemsEnabled reports whether a demucs binary was configured and actually exists.
func (m *Media) StemsEnabled() bool {
	if m.cfg.Demucs == "" {
		return false
	}
	_, err := exec.LookPath(m.cfg.Demucs)
	return err == nil
}

func randomName() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b) + ".wav", nil
}

func (m *Media) scratch() (string, func(), error) {
	if err := os.MkdirAll(m.cfg.TmpDir(), 0o755); err != nil {
		return "", nil, err
	}
	dir, err := os.MkdirTemp(m.cfg.TmpDir(), "job-")
	if err != nil {
		return "", nil, err
	}
	return dir, func() { _ = os.RemoveAll(dir) }, nil
}

// FromUpload streams an uploaded file to disk and normalises it.
func (m *Media) FromUpload(ctx context.Context, r io.Reader, originalName string) (*Info, error) {
	dir, cleanup, err := m.scratch()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	raw := filepath.Join(dir, "input"+filepath.Ext(originalName))
	f, err := os.Create(raw)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}

	title := strings.TrimSuffix(filepath.Base(originalName), filepath.Ext(originalName))
	if title == "" {
		title = "Untitled upload"
	}

	info, err := m.normalise(ctx, raw)
	if err != nil {
		return nil, err
	}
	info.Title = title
	return info, nil
}

// FromURL hands the link to yt-dlp, which is why this works for a lot more than youtube.
func (m *Media) FromURL(ctx context.Context, link string) (*Info, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("that does not look like an http or https link")
	}

	dir, cleanup, err := m.scratch()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	dlCtx, cancel := context.WithTimeout(ctx, 12*time.Minute)
	defer cancel()

	title := "Untitled"
	titleOut, err := run(dlCtx, m.cfg.YtDlp,
		"--no-playlist", "--no-warnings", "--skip-download",
		"--print", "%(title)s", u.String())
	if err == nil {
		if t := strings.TrimSpace(firstLine(titleOut)); t != "" {
			title = t
		}
	}

	if _, err := run(dlCtx, m.cfg.YtDlp,
		"--no-playlist", "--no-warnings", "--no-progress",
		"-f", "bestaudio/best",
		"-o", filepath.Join(dir, "input.%(ext)s"),
		u.String()); err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}

	matches, err := filepath.Glob(filepath.Join(dir, "input.*"))
	if err != nil || len(matches) == 0 {
		return nil, errors.New("download finished but produced no audio file")
	}

	info, err := m.normalise(ctx, matches[0])
	if err != nil {
		return nil, err
	}
	info.Title = title
	return info, nil
}

// Stems runs demucs and returns stem name to absolute wav path.
func (m *Media) Stems(ctx context.Context, sourceFile string) (map[string]*Info, error) {
	if !m.StemsEnabled() {
		return nil, errors.New("stem separation is not enabled on this server")
	}

	dir, cleanup, err := m.scratch()
	if err != nil {
		return nil, err
	}
	defer cleanup()

	sepCtx, cancel := context.WithTimeout(ctx, 45*time.Minute)
	defer cancel()

	in := filepath.Join(m.cfg.AudioDir(), sourceFile)
	if _, err := run(sepCtx, m.cfg.Demucs,
		"-n", m.cfg.DemucsModel, "--wav", "-o", dir, in); err != nil {
		// A demucs run on cpu wants several gigabytes of ram for a full length
		// track. When the kernel oom killer takes it there is no stderr at all,
		// just a dead process, so say so rather than showing an empty error.
		msg := err.Error()
		if strings.Contains(msg, "signal: killed") || strings.Contains(msg, "exit status 137") {
			return nil, errors.New("demucs was killed, most likely out of memory. " +
				"stem separation on cpu needs several gigabytes free for a full track")
		}
		return nil, fmt.Errorf("demucs failed: %w", err)
	}

	found, err := filepath.Glob(filepath.Join(dir, m.cfg.DemucsModel, "*", "*.wav"))
	if err != nil {
		return nil, err
	}
	if len(found) == 0 {
		return nil, errors.New("demucs produced no stems")
	}

	out := map[string]*Info{}
	for _, p := range found {
		stem := strings.TrimSuffix(filepath.Base(p), ".wav")
		info, err := m.normalise(ctx, p)
		if err != nil {
			return nil, err
		}
		out[stem] = info
	}
	return out, nil
}

// normalise transcodes anything into a 16 bit pcm wav inside the audio dir.
func (m *Media) normalise(ctx context.Context, input string) (*Info, error) {
	if err := os.MkdirAll(m.cfg.AudioDir(), 0o755); err != nil {
		return nil, err
	}

	name, err := randomName()
	if err != nil {
		return nil, err
	}
	dest := filepath.Join(m.cfg.AudioDir(), name)

	ffCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()

	if _, err := run(ffCtx, m.cfg.FFmpeg,
		"-y", "-hide_banner", "-loglevel", "error",
		"-i", input,
		"-map", "0:a:0",
		"-c:a", "pcm_s16le",
		"-f", "wav",
		dest); err != nil {
		_ = os.Remove(dest)
		return nil, fmt.Errorf("transcode failed (is there an audio stream?): %w", err)
	}

	info, err := m.probe(ctx, dest)
	if err != nil {
		_ = os.Remove(dest)
		return nil, err
	}
	info.FileName = name
	return info, nil
}

type probeOut struct {
	Streams []struct {
		SampleRate string `json:"sample_rate"`
		Channels   int    `json:"channels"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
		Size     string `json:"size"`
	} `json:"format"`
}

func (m *Media) probe(ctx context.Context, path string) (*Info, error) {
	pCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	out, err := run(pCtx, m.cfg.FFprobe,
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=sample_rate,channels",
		"-show_entries", "format=duration,size",
		"-of", "json", path)
	if err != nil {
		return nil, fmt.Errorf("probe failed: %w", err)
	}

	var p probeOut
	if err := json.Unmarshal([]byte(out), &p); err != nil {
		return nil, err
	}
	info := &Info{}
	if len(p.Streams) > 0 {
		info.SampleRate, _ = strconv.Atoi(p.Streams[0].SampleRate)
		info.Channels = p.Streams[0].Channels
	}
	info.Duration, _ = strconv.ParseFloat(p.Format.Duration, 64)
	info.SizeBytes, _ = strconv.ParseInt(p.Format.Size, 10, 64)
	return info, nil
}

func run(ctx context.Context, bin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return "", errors.New(msg)
	}
	return stdout.String(), nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
