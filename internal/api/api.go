// Package api wires the http routes.
package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mathiiiiiis/chopper/internal/config"
	"github.com/mathiiiiiis/chopper/internal/media"
	"github.com/mathiiiiiis/chopper/internal/store"
	"github.com/mathiiiiiis/chopper/web"
)

const cookieName = "chopper_session"
const sessionTTL = 30 * 24 * time.Hour

type API struct {
	cfg   config.Config
	st    *store.Store
	media *media.Media
}

func New(cfg config.Config, st *store.Store, m *media.Media) *API {
	return &API{cfg: cfg, st: st, media: m}
}

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("GET /api/me", a.guard(a.me))

	mux.HandleFunc("GET /api/sources", a.guard(a.listSources))
	mux.HandleFunc("POST /api/sources/upload", a.guard(a.uploadSource))
	mux.HandleFunc("POST /api/sources/link", a.guard(a.linkSource))
	mux.HandleFunc("GET /api/sources/{id}/audio", a.guard(a.sourceAudio))
	mux.HandleFunc("POST /api/sources/{id}/stems", a.guard(a.sourceStems))
	mux.HandleFunc("DELETE /api/sources/{id}", a.guard(a.deleteSource))

	mux.HandleFunc("GET /api/projects", a.guard(a.listProjects))
	mux.HandleFunc("POST /api/projects", a.guard(a.createProject))
	mux.HandleFunc("GET /api/projects/{id}", a.guard(a.getProject))
	mux.HandleFunc("PUT /api/projects/{id}", a.guard(a.saveProject))
	mux.HandleFunc("POST /api/projects/{id}/sources", a.guard(a.addProjectSource))
	mux.HandleFunc("DELETE /api/projects/{id}/sources/{sid}", a.guard(a.removeProjectSource))
	mux.HandleFunc("DELETE /api/projects/{id}", a.guard(a.deleteProject))

	mux.Handle("GET /", a.static())

	return logger(mux)
}

func (a *API) static() http.Handler {
	if a.cfg.WebDir != "" {
		return http.FileServer(http.Dir(a.cfg.WebDir))
	}
	sub, err := fs.Sub(web.Files, "public")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}

// ==== auth ====

// A session is just an expiry timestamp signed with the server secret. Two users,
// one shared password, no user table. That is the whole threat model here.

func (a *API) sign(payload string) string {
	mac := hmac.New(sha256.New, []byte(a.cfg.SessionSecret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *API) issue() string {
	payload := strconv.FormatInt(time.Now().Add(sessionTTL).Unix(), 10)
	return payload + "." + a.sign(payload)
}

func (a *API) valid(token string) bool {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(a.sign(parts[0])), []byte(parts[1])) != 1 {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}
	return time.Now().Unix() < exp
}

func (a *API) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil || !a.valid(c.Value) {
			fail(w, http.StatusUnauthorized, "Sign in to continue.")
			return
		}
		next(w, r)
	}
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "Send a password.")
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Password), []byte(a.cfg.AuthPassword)) != 1 {
		time.Sleep(600 * time.Millisecond)
		fail(w, http.StatusUnauthorized, "Wrong password.")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    a.issue(),
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(sessionTTL),
	})
	ok(w, map[string]any{"ok": true})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   a.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	ok(w, map[string]any{"ok": true})
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"ok": true, "stems": a.media.StemsEnabled()})
}

// ==== sources ====

func (a *API) listSources(w http.ResponseWriter, r *http.Request) {
	list, err := a.st.ListSources(r.Context())
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

func (a *API) uploadSource(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, a.cfg.MaxUploadBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		fail(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("That file is bigger than the %d MB limit.", a.cfg.MaxUploadBytes/1024/1024))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, http.StatusBadRequest, "Attach a file under the field name file.")
		return
	}
	defer file.Close()

	info, err := a.media.FromUpload(r.Context(), file, header.Filename)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	src, err := a.st.CreateSource(r.Context(), store.Source{
		Title:      info.Title,
		Origin:     "upload",
		FileName:   info.FileName,
		Duration:   info.Duration,
		SampleRate: info.SampleRate,
		Channels:   info.Channels,
		SizeBytes:  info.SizeBytes,
	})
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, src)
}

func (a *API) linkSource(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "Send a url.")
		return
	}

	info, err := a.media.FromURL(r.Context(), body.URL)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	src, err := a.st.CreateSource(r.Context(), store.Source{
		Title:      info.Title,
		Origin:     "link",
		SourceURL:  body.URL,
		FileName:   info.FileName,
		Duration:   info.Duration,
		SampleRate: info.SampleRate,
		Channels:   info.Channels,
		SizeBytes:  info.SizeBytes,
	})
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, src)
}

func (a *API) sourceAudio(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	src, err := a.st.GetSource(r.Context(), id)
	if err != nil {
		notFound(w, err)
		return
	}

	// filepath.Base keeps a crafted file_name from ever escaping the audio dir.
	path := filepath.Join(a.cfg.AudioDir(), filepath.Base(src.FileName))
	f, err := os.Open(path)
	if err != nil {
		fail(w, http.StatusNotFound, "The audio file for this source is missing on disk.")
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		oops(w, err)
		return
	}

	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition",
			fmt.Sprintf("attachment; filename=%q", safeFileName(src.Title)+".wav"))
	}
	http.ServeContent(w, r, src.FileName, stat.ModTime(), f)
}

func (a *API) sourceStems(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	src, err := a.st.GetSource(r.Context(), id)
	if err != nil {
		notFound(w, err)
		return
	}
	if src.ParentID != nil {
		fail(w, http.StatusBadRequest, "This is already a stem.")
		return
	}

	stems, err := a.media.Stems(r.Context(), src.FileName)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	out := []store.Source{}
	for stem, info := range stems {
		created, err := a.st.CreateSource(r.Context(), store.Source{
			Title:      src.Title + " [" + stem + "]",
			Origin:     "stem",
			ParentID:   &src.ID,
			Stem:       stem,
			FileName:   info.FileName,
			Duration:   info.Duration,
			SampleRate: info.SampleRate,
			Channels:   info.Channels,
			SizeBytes:  info.SizeBytes,
		})
		if err != nil {
			oops(w, err)
			return
		}
		out = append(out, *created)
	}
	ok(w, out)
}

func (a *API) deleteSource(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	files, err := a.st.DeleteSource(r.Context(), id)
	if err != nil {
		oops(w, err)
		return
	}
	for _, name := range files {
		_ = os.Remove(filepath.Join(a.cfg.AudioDir(), filepath.Base(name)))
	}
	ok(w, map[string]any{"deleted": len(files)})
}

// ==== projects ====

func (a *API) listProjects(w http.ResponseWriter, r *http.Request) {
	list, err := a.st.ListProjects(r.Context())
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

func (a *API) createProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SourceID int64  `json:"source_id"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "Send source_id and name.")
		return
	}
	if strings.TrimSpace(body.Name) == "" {
		body.Name = "Untitled chop"
	}
	p, err := a.st.CreateProject(r.Context(), body.SourceID, body.Name)
	if err != nil {
		fail(w, http.StatusBadRequest, "Could not create that project: "+err.Error())
		return
	}
	ok(w, p)
}

func (a *API) getProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	p, err := a.st.GetProject(r.Context(), id)
	if err != nil {
		notFound(w, err)
		return
	}
	ok(w, p)
}

func (a *API) saveProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}

	var body store.Project
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "Could not read that project.")
		return
	}
	body.ID = id
	if strings.TrimSpace(body.Name) == "" {
		body.Name = "Untitled chop"
	}
	if body.BeatsPerBar <= 0 {
		body.BeatsPerBar = 4
	}
	if body.Bars <= 0 {
		body.Bars = 4
	}
	if body.Slices == nil {
		body.Slices = []store.Slice{}
	}
	if body.Sources == nil {
		body.Sources = []store.ProjectSource{}
	}
	if body.Events == nil {
		body.Events = []store.PerfEvent{}
	}

	p, err := a.st.SaveProject(r.Context(), body)
	if err != nil {
		notFound(w, err)
		return
	}
	ok(w, p)
}

func (a *API) addProjectSource(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	var body struct {
		SourceID int64 `json:"source_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "Send a source_id.")
		return
	}
	if err := a.st.AddProjectSource(r.Context(), id, body.SourceID); err != nil {
		fail(w, http.StatusBadRequest, "Could not add that source: "+err.Error())
		return
	}
	p, err := a.st.GetProject(r.Context(), id)
	if err != nil {
		notFound(w, err)
		return
	}
	ok(w, p)
}

func (a *API) removeProjectSource(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	sid, err := strconv.ParseInt(r.PathValue("sid"), 10, 64)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad source id.")
		return
	}
	if err := a.st.RemoveProjectSource(r.Context(), id, sid); err != nil {
		oops(w, err)
		return
	}
	p, err := a.st.GetProject(r.Context(), id)
	if err != nil {
		notFound(w, err)
		return
	}
	ok(w, p)
}

func (a *API) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "Bad id.")
		return
	}
	if err := a.st.DeleteProject(r.Context(), id); err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]any{"ok": true})
}

// ==== helpers ====

func pathID(r *http.Request) (int64, error) {
	return strconv.ParseInt(r.PathValue("id"), 10, 64)
}

func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func notFound(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, http.StatusNotFound, "Not found.")
		return
	}
	oops(w, err)
}

func oops(w http.ResponseWriter, err error) {
	log.Printf("error: %v", err)
	fail(w, http.StatusInternalServerError, "Something broke on the server. Check the logs.")
}

func safeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "source"
	}
	if len(out) > 60 {
		out = out[:60]
	}
	return out
}

func logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
