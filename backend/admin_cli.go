package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

func main() {
	dbURL := os.Getenv("DB_URL")
	if dbURL == "" {
		dbURL = "postgres://dropzone_user:dropzone_password@localhost:5432/dropzone_db?sslmode=disable"
	}

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatal(err)
	}

	if len(os.Args) < 2 {
		fmt.Println("Usage: ./dropzone-admin [create|list|revoke] [args]")
		return
	}

	command := os.Args[1]

	switch command {
	case "create":
		if len(os.Args) < 3 {
			fmt.Println("Usage: create [owner_name]")
			return
		}
		name := os.Args[2]
		id := uuid.New().String()
		key := uuid.New().String()
		_, err := db.Exec("INSERT INTO api_keys (id, key_value, owner_name) VALUES ($1, $2, $3)", id, key, name)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("Created API Key for %s\nID: %s\nKEY: %s\n", name, id, key)

	case "list":
		rows, err := db.Query("SELECT id, key_value, owner_name, is_active FROM api_keys")
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("%-36s | %-36s | %-15s | %-8s\n", "ID", "KEY", "OWNER", "ACTIVE")
		for rows.Next() {
			var id, key, owner string
			var active bool
			rows.Scan(&id, &key, &owner, &active)
			fmt.Printf("%-36s | %-36s | %-15s | %v\n", id, key, owner, active)
		}

	case "revoke":
		if len(os.Args) < 3 {
			fmt.Println("Usage: revoke [id]")
			return
		}
		id := os.Args[2]
		_, err := db.Exec("UPDATE api_keys SET is_active = FALSE WHERE id = $1", id)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println("Key revoked.")

	default:
		fmt.Println("Unknown command")
	}
}