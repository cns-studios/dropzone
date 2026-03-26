package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/mux"
	_ "github.com/lib/pq"
)

func main() {
	dbURL := os.Getenv("DB_URL")
	if dbURL == "" {
		dbURL = "postgres://dropzone_user:dropzone_password@localhost:5432/dropzone_db?sslmode=disable"
	}

	var err error
	for i := 0; i < 10; i++ {
		err = InitDB(dbURL)
		if err == nil {
			break
		}
		log.Printf("Waiting for DB... %v", err)
		time.Sleep(2 * time.Second)
	}

	if err != nil {
		log.Fatal(err)
	}

	r := mux.NewRouter()

	r.HandleFunc("/auth/verify", VerifyKeyHandler).Methods("GET")
	r.HandleFunc("/ws/notifications", NotificationHandler)

	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/upload", AuthMiddleware(UploadHandler)).Methods("POST")
	api.HandleFunc("/files", AuthMiddleware(ListFilesHandler)).Methods("GET")
	api.HandleFunc("/files/{id}", AuthMiddleware(DownloadHandler)).Methods("GET")

	log.Println("Dropzone API running on :8080")
	log.Fatal(http.ListenAndServe(":8080", r))
}