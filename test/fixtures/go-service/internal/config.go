// Package internal holds the fixture configuration. Never built, never run.
package internal

import "os"

// Config is loaded once at startup.
type Config struct {
	DatabaseURL  string
	MetricsToken string
}

// Load reads DATABASE_URL without a fallback, so the process fails when it is
// absent, plus METRICS_TOKEN which no env file and no example documents.
func Load() Config {
	return Config{
		DatabaseURL:  os.Getenv("DATABASE_URL"),
		MetricsToken: os.Getenv("METRICS_TOKEN"),
	}
}
