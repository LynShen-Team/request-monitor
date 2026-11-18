# Build the service as one executable that contains the front end.
.PHONY: build test web clean

build: web
	go build -tags embedweb -trimpath -o bin/opsscreen ./cmd/opsscreen

# Build web/ and copy the result to where the binary embeds it from.
web:
	cd ../web && bun install --frozen-lockfile && bun run build
	rm -rf internal/webui/dist
	cp -R ../web/dist internal/webui/dist

test:
	go vet ./...
	go test ./...

clean:
	rm -rf bin internal/webui/dist
