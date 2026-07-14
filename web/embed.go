// Package web carries the frontend into the binary so deployment is a single file.
package web

import "embed"

//go:embed all:public
var Files embed.FS
