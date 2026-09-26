// Vendored dependency. The walker never descends into vendor/, so neither the
// package name nor the read below may reach the audit.
package vendorstub

import "os"

// Endpoint is a read inside vendored code.
func Endpoint() string {
	return os.Getenv("VENDORED_ONLY_KEY")
}
