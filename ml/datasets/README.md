# ML datasets

## Dataset & artifact policy

**Datasets are external and never committed to this repo.** No images, no
video, no trained weights, no RPC or SKU-110K files, no customer or store
media. This repo stores pipeline code, the manifest schema, docs, tests,
and tiny synthetic JSON examples only — the root `.gitignore` enforces
this by ignoring every dataset's `raw/` and `processed/` subdirectory (and,
for `byond-custom/`, its `manifest.json` and `annotations/` too, since real
captures there carry store/tenant identifiers and label data).

Each dataset directory below follows the same shape:

```
ml/datasets/<name>/
  README.md    # how to obtain the data and where to place it
  raw/         # gitignored — you place the manually-downloaded dataset here
  processed/   # gitignored — output of the matching prepare_*.py script
```

## Datasets

| Directory | Dataset | Prepared by |
| --- | --- | --- |
| `ml/datasets/rpc/` | RPC (Retail Product Checkout) — large-scale retail SKU dataset | `ml/scripts/prepare_rpc.py` |
| `ml/datasets/sku-110k/` | SKU-110K — dense shelf product detection (single "product" class) | `ml/scripts/prepare_sku110k.py` |
| `ml/datasets/byond-custom/` | Future real BYOND store data (shelf/pickup/return/cart/exit captures) | `ml/scripts/prepare_byond_dataset.py` |

See each dataset's own README for exact source, license notes, and the
expected `raw/` layout before running its prepare script.
