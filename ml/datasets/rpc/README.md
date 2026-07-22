# RPC (Retail Product Checkout) dataset

RPC is a large-scale retail SKU dataset used for product detection and
recognition benchmarking. It is a public academic dataset with its own
license and terms of use.

**BYOND never redistributes RPC.** This repo does not download, mirror, or
commit any RPC file. `ml/datasets/rpc/raw/` and `ml/datasets/rpc/processed/`
are gitignored.

## Getting the data

Download RPC yourself from its official source, per its license terms, and
place it under `ml/datasets/rpc/raw/` in the dataset's native layout:

```
ml/datasets/rpc/raw/
  train2019/
  val2019/
  test2019/
  instances_train2019.json
  instances_val2019.json
  instances_test2019.json
```

## Preparing the dataset

```bash
python ml/scripts/prepare_rpc.py --input ml/datasets/rpc/raw --output ml/datasets/rpc/processed
```

The generated `processed/manifest.json` references the source images and
per-split COCO annotation files in place via its `sourceRoot` field
(`../raw` in the layout above) — nothing is copied out of `raw/`. The
non-dry-run also verifies every referenced file exists under the input
root and fails otherwise.

Use `--dry-run` to check the script's plan without requiring anything on
disk (useful for CI and for reviewing the intended output layout before
downloading the real dataset).

CI never requires these files — no test depends on the real RPC dataset
being present.
