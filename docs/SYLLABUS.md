# Public syllabus access

The SUSTech mirror publishes course syllabus PDFs without login. The CLI
normalizes a course code to uppercase and uses its public PDF endpoint:

```bash
sustech mirror syllabus url CS109 --json
sustech mirror syllabus check CS109 --json
sustech mirror syllabus download CS109 --destination ./CS109.pdf --json
```

`url` builds PDF and HTML links without network access. `check` sends a HEAD
request for the PDF and returns `available` or `not-found`; rate limits, server
errors, and transport failures remain errors. HTML links are always marked
`unchecked`. A successful HEAD request does not validate PDF contents.

`download` requires an existing destination directory. It refuses existing
files unless `--overwrite` is supplied, rejects symbolic links, limits the PDF
to 50 MiB, and validates its signature before atomically publishing the file.
The result includes its source URL, absolute path, size, and SHA-256 digest.
Requests are anonymous and redirects must stay in the mirror's HTTPS syllabus
directory. No TIS or Blackboard credentials are used.

The mirror can contain older course specifications. Check the document's date
and the selected teaching task before treating it as the current syllabus.
Authenticated `tis courses detail CODE` remains the route for structured TIS
course content and TIS-hosted syllabus attachment links.

PDF text extraction, OCR, and bulk directory downloads are not included.
The read-only MCP tools are `sustech_mirror_syllabus_url` and
`sustech_mirror_syllabus_check`; file downloads run through the CLI.
