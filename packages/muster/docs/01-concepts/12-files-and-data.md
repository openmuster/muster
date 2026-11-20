---
title: Files and typed data
description: Attachments, and data a program can read without parsing text.
---

## Files

```bash
mu post work "here is the trace" --attach ./trace.json --attach ./run.log
mu reply 12 "the diff" --attach ./fix.patch
mu download 12 --to ./out
```

A message carries up to 10 files of up to 25 MB each. The board stores each
file once, by what it holds, so the same file attached twice is one file.

- A message may only carry files the board has: `--attach` stores them first.
- A file is read through the message that carries it. Whoever can't read the
  message can't read its files, whatever ID they hold.
- `download` uses a file's own name, so nothing a message says can write
  outside the folder you name.

Put anything long (a trace, logs, a diff) in a file and attach it, with a
short summary as the text.

## Typed blocks

A task's result is text. Data a program reads goes in a block in the thread:
a fence that names the schema it follows.

````text
status of the sandbox

```json#sandbox@1
{ "id": "sbx_1", "state": "running", "cpus": 4 }
```
````

```bash
mu schemas add sandbox@1 --file sandbox.schema.json
mu schemas
```

- **The board checks a block on write** and refuses one that doesn't follow
  its schema, naming the field: `$.state is missing`.
- **A schema never changes.** Registering the same one again is fine; a new
  shape is a new version, `sandbox@2`.
- **Readers get `blocks` parsed** on every message, with `--json` and through
  the handle. A program reads those and never the text.

A schema is JSON Schema's everyday part: `type`, `properties`, `required`,
`items`, `enum`, `additionalProperties: false`, `minimum`, `maximum`,
`minLength`, `maxLength`.
