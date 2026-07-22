# ML scripts

All scripts are plain Python (stdlib-only), runnable from the repo root.
Each exits `0` on success and `1` on a validation failure.

## `validate_dataset_manifest.py`

Validates a dataset manifest JSON file against
`ml/configs/dataset.schema.json`.

```bash
python ml/scripts/validate_dataset_manifest.py <manifest.json> [--check-files] [--base-dir DIR]
```

- `--check-files` — additionally confirms every file the manifest
  references (sample images/annotations and per-split `annotations`
  files) exists on disk, resolved relative to `--base-dir`. When
  `--base-dir` is not given, it defaults to the manifest's `sourceRoot`
  resolved against the manifest's own directory (or that directory
  itself when no `sourceRoot` is present).
- Exit `0`: manifest is schema-valid (and, with `--check-files`, every
  referenced file exists). Exit `1`: schema violation or a missing file.

## `prepare_rpc.py`

Normalizes a raw RPC download into the manifest-described processed
layout.

```bash
python ml/scripts/prepare_rpc.py --input DIR --output DIR [--dry-run]
```

- `--dry-run` — prints the plan (what would be read/written) without
  requiring anything on disk and without writing any output. Safe to run
  with no dataset present.
- Exit `0`: prepared (or, with `--dry-run`, planned) successfully. Exit
  `1`: validation failure (e.g. unexpected input layout).

## `prepare_sku110k.py`

Normalizes a raw SKU-110K download into the manifest-described processed
layout.

```bash
python ml/scripts/prepare_sku110k.py --input DIR --output DIR [--dry-run]
```

- `--dry-run` — same semantics as `prepare_rpc.py`: prints the plan,
  requires nothing on disk, writes nothing.
- Exit `0`: prepared (or planned) successfully. Exit `1`: validation
  failure.

Both `prepare_rpc.py` and `prepare_sku110k.py` write reference-only
manifests: samples and per-split `annotations` entries point at the
original files in place via a `sourceRoot` (typically `../raw`) — nothing
is copied into the output directory. Their non-dry-run path validates the
generated manifest with file checks enabled, so a manifest that references
images or annotation files missing under the input root fails with a
non-zero exit and a capped list of the missing paths.

## `prepare_byond_dataset.py`

Validates (and, when an output is given, prepares) a BYOND custom dataset
directory — see `ml/datasets/byond-custom/README.md` for the expected
input layout.

```bash
python ml/scripts/prepare_byond_dataset.py --input DIR [--output DIR] [--dry-run]
```

- `--dry-run` — validates and prints the plan without requiring the
  dataset to be fully populated on disk and without writing output.
- Without `--dry-run`, also checks that every file referenced by the
  dataset's `manifest.json` is actually present.
- Exit `0`: valid. Exit `1`: validation failure (bad SKU ID, missing
  reference, malformed split, or missing file).

## `sample_inference_to_vision_event.py`

Maps a model's raw inference output JSON to a Phase 7
`POST /vision-events` ingest payload.

```bash
python ml/scripts/sample_inference_to_vision_event.py <model_output.json> [--out FILE]
```

- With no `--out`, prints the mapped `VisionEvent` payload JSON to stdout.
- With `--out FILE`, writes it to `FILE` instead.
- Exit `0`: mapped successfully. Exit `1`: the input couldn't be mapped to
  a valid payload (e.g. missing required field).

## Tests

```bash
python -m unittest discover -s ml/tests -p "test_*.py"
# or, from the repo root:
pnpm run ml:test
```
