package main

import (
	"database/sql"
	"time"
)

type APIKey struct {
	ID        string    `json:"id"`
	Key       string    `json:"key"`
	OwnerName string    `json:"owner_name"`
	CreatedAt time.Time `json:"created_at"`
	IsActive  bool      `json:"is_active"`
}

type FileMetadata struct {
	ID         string    `json:"id"`
	APIKeyID   string    `json:"api_key_id"`
	FileName   string    `json:"file_name"`
	FilePath   string    `json:"file_path"`
	FileSize   int64     `json:"file_size"`
	UploadedAt time.Time `json:"uploaded_at"`
}

var db *sql.DB

func InitDB(connStr string) error {
	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		return err
	}

	queries := []string{
		`CREATE TABLE IF NOT EXISTS api_keys (
			id UUID PRIMARY KEY,
			key_value TEXT UNIQUE NOT NULL,
			owner_name TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			is_active BOOLEAN DEFAULT TRUE
		)`,
		`CREATE TABLE IF NOT EXISTS files (
			id UUID PRIMARY KEY,
			api_key_id UUID REFERENCES api_keys(id),
			file_name TEXT NOT NULL,
			file_path TEXT NOT NULL,
			file_size BIGINT,
			uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)`,
	}

	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}