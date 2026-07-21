# BYOND custom dataset (future real store data)

This directory is reserved for future data captured from real BYOND
stores — not part of the Phase 8 MVP scope, but the expected layout is
documented here so the pipeline and tooling can be built against it now.

**Customer and store media never leaves controlled storage and is NEVER
committed to this repo.** `ml/datasets/byond-custom/raw/` and
`ml/datasets/byond-custom/processed/` are gitignored.

## Expected layout

```
ml/datasets/byond-custom/
  raw/
    products/
    shelves/
    pickup/
    return/
    cart/
  annotations/
  manifest.json
```

Capture contexts map to the Phase 7 `VisionEvent` types this data
ultimately trains models to support: `shelf`, `pickup`, `return`,
`cart_insertion`, and `exit`.

## Preparing / validating the dataset

```bash
python ml/scripts/prepare_byond_dataset.py --input ml/datasets/byond-custom [--output DIR] [--dry-run]
```

`prepare_byond_dataset.py` validates:

- SKU IDs (uppercase, must map to a tenant catalog SKU),
- image/annotation references in `manifest.json`,
- split structure, and
- (non-dry-run only) that no file referenced by the manifest is missing
  on disk.

CI never requires real data here — no test depends on `raw/` being
populated.
