// Package config loads runtime settings from the environment.
package config

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Addr           string
	DatabaseURL    string
	DataDir        string
	WebDir         string
	AuthPassword   string
	SessionSecret  string
	YtDlp          string
	FFmpeg         string
	FFprobe        string
	Demucs         string
	DemucsModel    string
	MaxUploadBytes int64
	SecureCookie   bool
}

// AudioDir is where every canonical wav lives.
func (c Config) AudioDir() string { return filepath.Join(c.DataDir, "audio") }

// TmpDir is scratch space for downloads and stem separation.
func (c Config) TmpDir() string { return filepath.Join(c.DataDir, "tmp") }

func Load() Config {
	c := Config{
		Addr:           env("ADDR", ":8080"),
		DatabaseURL:    env("DATABASE_URL", ""),
		DataDir:        env("DATA_DIR", "./data"),
		WebDir:         env("WEB_DIR", ""),
		AuthPassword:   env("AUTH_PASSWORD", ""),
		SessionSecret:  env("SESSION_SECRET", ""),
		YtDlp:          env("YTDLP_BIN", "yt-dlp"),
		FFmpeg:         env("FFMPEG_BIN", "ffmpeg"),
		FFprobe:        env("FFPROBE_BIN", "ffprobe"),
		Demucs:         env("DEMUCS_BIN", ""),
		DemucsModel:    env("DEMUCS_MODEL", "htdemucs"),
		MaxUploadBytes: int64(envInt("MAX_UPLOAD_MB", 300)) * 1024 * 1024,
		SecureCookie:   env("SECURE_COOKIE", "true") == "true",
	}

	if c.DatabaseURL == "" {
		log.Fatal("config: DATABASE_URL is required")
	}
	if c.AuthPassword == "" {
		log.Fatal("config: AUTH_PASSWORD is required")
	}
	if c.SessionSecret == "" {
		log.Fatal("config: SESSION_SECRET is required (any long random string)")
	}
	return c
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
