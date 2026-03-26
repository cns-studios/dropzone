package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

var (
	clients   = make(map[string][]*websocket.Conn)
	clientsMu sync.Mutex
)

func AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-API-KEY")
		var keyID string
		err := db.QueryRow("SELECT id FROM api_keys WHERE key_value = $1 AND is_active = TRUE", apiKey).Scan(&keyID)
		if err != nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		r.Header.Set("X-INTERNAL-KEY-ID", keyID)
		next.ServeHTTP(w, r)
	}
}

func VerifyKeyHandler(w http.ResponseWriter, r *http.Request) {
	apiKey := r.URL.Query().Get("key")
	var owner string
	err := db.QueryRow("SELECT owner_name FROM api_keys WHERE key_value = $1 AND is_active = TRUE", apiKey).Scan(&owner)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "valid", "owner": owner})
}

func UploadHandler(w http.ResponseWriter, r *http.Request) {
	keyID := r.Header.Get("X-INTERNAL-KEY-ID")
	r.ParseMultipartForm(100 << 20) // 100MB limit

	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "File upload error", http.StatusBadRequest)
		return
	}
	defer file.Close()

	fileID := uuid.New().String()
	ext := filepath.Ext(handler.Filename)
	savePath := filepath.Join(os.Getenv("UPLOAD_DIR"), fileID+ext)

	dst, err := os.Create(savePath)
	if err != nil {
		http.Error(w, "Storage error", http.StatusInternalServerError)
		return
	}
	defer dst.Close()
	io.Copy(dst, file)

	_, err = db.Exec("INSERT INTO files (id, api_key_id, file_name, file_path, file_size) VALUES ($1, $2, $3, $4, $5)",
		fileID, keyID, handler.Filename, savePath, handler.Size)

	notifyClients(keyID, handler.Filename)

	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, "Uploaded %s", handler.Filename)
}

func ListFilesHandler(w http.ResponseWriter, r *http.Request) {
	keyID := r.Header.Get("X-INTERNAL-KEY-ID")
	rows, err := db.Query("SELECT id, file_name, file_size, uploaded_at FROM files WHERE api_key_id = $1 ORDER BY uploaded_at DESC", keyID)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	files := []FileMetadata{}
	for rows.Next() {
		var f FileMetadata
		rows.Scan(&f.ID, &f.FileName, &f.FileSize, &f.UploadedAt)
		files = append(files, f)
	}
	json.NewEncoder(w).Encode(files)
}

func DownloadHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	fileID := vars["id"]
	keyID := r.Header.Get("X-INTERNAL-KEY-ID")

	var path, name string
	err := db.QueryRow("SELECT file_path, file_name FROM files WHERE id = $1 AND api_key_id = $2", fileID, keyID).Scan(&path, &name)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", "attachment; filename="+name)
	http.ServeFile(w, r, path)
}

func NotificationHandler(w http.ResponseWriter, r *http.Request) {
	apiKey := r.URL.Query().Get("key")
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	clientsMu.Lock()
	clients[apiKey] = append(clients[apiKey], conn)
	clientsMu.Unlock()
}

func notifyClients(apiKeyID string, filename string) {
	clientsMu.Lock()
	defer clientsMu.Unlock()

	var apiKeyStr string
	db.QueryRow("SELECT key_value FROM api_keys WHERE id = $1", apiKeyID).Scan(&apiKeyStr)

	conns := clients[apiKeyStr]
	msg := map[string]string{"type": "new_file", "name": filename}
	payload, _ := json.Marshal(msg)

	for i := 0; i < len(conns); i++ {
		err := conns[i].WriteMessage(websocket.TextMessage, payload)
		if err != nil {
			conns[i].Close()
			conns = append(conns[:i], conns[i+1:]...)
			i--
		}
	}
	clients[apiKeyStr] = conns
}