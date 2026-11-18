//go:build embedweb

package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// Embedded reports whether the real front end is compiled in.
const Embedded = true

// Dist is the front end to serve.
func Dist() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
