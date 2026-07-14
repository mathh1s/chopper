package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mathiiiiiis/chopper/internal/api"
	"github.com/mathiiiiiis/chopper/internal/config"
	"github.com/mathiiiiiis/chopper/internal/media"
	"github.com/mathiiiiiis/chopper/internal/store"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("chopper ")

	cfg := config.Load()

	if err := os.MkdirAll(cfg.AudioDir(), 0o755); err != nil {
		log.Fatalf("data dir: %v", err)
	}
	if err := os.MkdirAll(cfg.TmpDir(), 0o755); err != nil {
		log.Fatalf("tmp dir: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	m := media.New(cfg)
	if m.StemsEnabled() {
		log.Printf("stem separation enabled via %s", cfg.Demucs)
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.New(cfg, st, m).Routes(),
		ReadHeaderTimeout: 15 * time.Second,
		WriteTimeout:      0, // long downloads and long ingests, do not guillotine them
	}

	go func() {
		log.Printf("listening on %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Print("shutting down")

	shutCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
