// Real upstream WebDAV handler; no simulated MOVE or validator semantics.
package main

import (
	"flag"
	"log"
	"net/http"

	"golang.org/x/net/webdav"
)

func main() {
	root := flag.String("root", "", "Disposable test directory")
	addr := flag.String("addr", "127.0.0.1:0", "Loopback listen address")
	flag.Parse()
	if *root == "" {
		log.Fatal("-root required")
	}
	h := &webdav.Handler{FileSystem: webdav.Dir(*root), LockSystem: webdav.NewMemLS()}
	log.Fatal(http.ListenAndServe(*addr, h))
}
