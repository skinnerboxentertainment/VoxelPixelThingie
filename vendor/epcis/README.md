# Vendored EPCIS 2.0 artefacts

Fetched 2026-09-06 from GS1's reference site, unmodified:

- `epcis-json-schema.json` from https://ref.gs1.org/standards/epcis/2.0.0/epcis-json-schema.json
  (JSON Schema draft-07; `$id` inside the file names the same URL)
- `epcis-context.jsonld` from https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld

These are GS1 standard artefacts, copyright GS1 AISBL, provided under the
terms at https://www.gs1.org/standards/epcis. They are vendored so that
validation runs offline and pinned; they are not part of this project's
MIT-licensed code.

`vpb-extension-schema.json` is ours (MIT, like the rest of the code): the
JSON Schema for the `vpb:` extension fields `src/epcis.ts` writes, which a
repository that validates user extensions needs registered before capture.
`scripts/epcis-capture-check.ts` posts it to OpenEPCIS's
`/userExtension/jsonSchema` for the project namespace.
