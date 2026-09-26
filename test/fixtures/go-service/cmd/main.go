// Fixture source for envgle integration tests. Never built, never run.
package main

import (
	"fmt"
	"os"

	"github.com/example/go-service/internal"
)

func main() {
	port := os.Getenv("PORT")
	dsn, ok := os.LookupEnv("SENTRY_DSN")
	if !ok {
		dsn = ""
	}
	fmt.Println(port, dsn, internal.Load().DatabaseURL)
}
