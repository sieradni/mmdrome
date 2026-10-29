# Browser WebDAV permissions

See the [implementation compatibility matrix](WEBDAV-COMPATIBILITY.md) for live
server coverage and observed server-side failure limits.

The server or reverse proxy must allow the app's origin (for the hosted app,
`https://sieradni.github.io`). OPTIONS preflight must succeed for requests to
both music files and temporary files in the same directory.

For browser scanning and pushing, the baseline is:

```http
Access-Control-Allow-Origin: https://sieradni.github.io
Access-Control-Allow-Methods: GET, PROPFIND, PUT, MOVE, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type, Depth, Destination, Overwrite
```

The actual responses, including errors, also need the allowed-origin header.
DELETE permits cleanup of a temporary upload after a failed or cancelled write.
Servers must support overwriting a destination via MOVE and return an ETag or
last-modified property in PROPFIND XML. Server file permissions must permit
reading, creating temporary files, replacing the destination, and cleanup.

No application-supplied Cache-Control, If, If-Match or If-Unmodified-Since
permission is required. No Access-Control-Expose-Headers setting is
needed for the collision validators: they are read from PROPFIND XML. Single
byte-range reads use the browser's CORS-safelisted Range header; clients with
older Range/CORS behavior can additionally require Range in the allowlist.

Before a browser push, the app reads current validators, downloads fresh file
bytes, edits the tags, uploads a temporary file, then re-reads the destination.
If it changed, the app re-reads and merges once. If validators are missing or the
final check cannot compare them, the write fails and stays pending. Successful
browser writes are reported as `revalidated`, not server-enforced guards.

The final check and MOVE are separate requests. A concurrent write between them
can still be overwritten; these minimal permissions cannot provide an atomic
conditional replacement. Native iOS pushes retain the conditional-header ladder
because they are not subject to browser CORS.

The app explicitly sends `Overwrite: T` to replace the original file. Although
[RFC 4918 §10.6](https://www.rfc-editor.org/rfc/rfc4918.html#section-10.6)
defines T as the default, Go-style WebDAV servers require an explicit T on MOVE
and otherwise return 412 for an existing destination. Overwrite expresses
replacement intent; it is not a conditional validator such as If-Match.
Browser request-header permission checks are specified by the
[Fetch Standard](https://fetch.spec.whatwg.org/#cors-preflight-fetch).
